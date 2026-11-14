import { ConvexError, v } from "convex/values";

import { internal } from "@/convex/_generated/api";
import { internalMutation, mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { enrollmentAccess, checkRecruitment } from "@/convex/lib/enrollment";
import { operationReceipt, projectAccess, requireClientId } from "@/convex/lib/research";
import { checkStudyIssue } from "@/convex/lib/studyIssue";
import { studyVisitAccess, checkStudyVisit } from "@/convex/lib/studyVisit";
import { clinicalPayload } from "@/convex/schema";
import {
  clinicalPayloadSchema,
  validateClinicalTransition,
  hasClinicalWriteId,
} from "@/src/lib/clinical-record-model";
import { legacyClinicalVersionId } from "@/src/lib/clinical-version-model";
import { validateEnrollmentChange } from "@/src/lib/study-enrollment-model";
import { formDefinitionSchema } from "@/src/lib/study-form-model";
import { validateStudyIssueWrite } from "@/src/lib/study-issue-model";
import { studyVisitNeedsAuthorization } from "@/src/lib/study-visit-model";

export const list = query({
  args: { actorId: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId, membership } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    // Existing sex/diagnosis consent never implicitly authorizes free-text clinical data.
    if (membership.role !== "doctor") return [];
    const records = await ctx.db
      .query("clinicalRecords")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const patientIds = [...new Set(records.map((row) => row.patientClientId))];
    const available = new Set(
      (
        await Promise.all(
          patientIds.map(async (clientId) => {
            const patient = await ctx.db
              .query("patients")
              .withIndex("by_client", (q) =>
                q.eq("organizationId", args.organizationId).eq("clientId", clientId),
              )
              .unique();
            return patient && !patient.deleted ? clientId : null;
          }),
        )
      ).filter((id) => id !== null),
    );
    return records
      .filter((row) => available.has(row.patientClientId))
      .map(({ _id, _creationTime, organizationId, updatedBy, ...row }) => row);
  },
});
export const apply = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    patientClientId: v.string(),
    expectedRevision: v.number(),
    expectedWriteId: v.optional(v.union(v.string(), v.null())),
    historyId: v.optional(v.string()),
    expectedHistoryId: v.optional(v.union(v.string(), v.null())),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    payload: v.optional(clinicalPayload),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId, true);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    requireClientId(args.patientClientId);
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    const parsed = args.action === "delete" ? null : clinicalPayloadSchema.safeParse(args.payload);
    if (args.action === "delete" ? args.payload !== undefined : !parsed?.success)
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    const payload = parsed?.success ? parsed.data : null;
    const patient = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.patientClientId),
      )
      .unique();
    if (!patient || patient.deleted) throw new ConvexError("PATIENT_NOT_FOUND");
    const existing = await ctx.db
      .query("clinicalRecords")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.clientId),
      )
      .unique();
    if (existing && existing.patientClientId !== args.patientClientId)
      throw new ConvexError("ACCESS_DENIED");
    const versionedWrite = hasClinicalWriteId(payload) || hasClinicalWriteId(existing?.payload);
    if (args.expectedWriteId !== undefined && args.expectedWriteId !== null)
      requireClientId(args.expectedWriteId);
    if (
      versionedWrite &&
      (args.expectedWriteId === undefined ||
        (args.action === "create" ? args.expectedWriteId !== null : args.expectedWriteId === null))
    )
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    if (args.historyId !== undefined) {
      requireClientId(args.historyId);
      if (args.expectedHistoryId === undefined) throw new ConvexError("INVALID_CLINICAL_RECORD");
    }
    if (args.expectedHistoryId !== undefined && args.historyId === undefined)
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    if (args.expectedHistoryId !== undefined && args.expectedHistoryId !== null)
      requireClientId(args.expectedHistoryId);
    const enrollmentProject =
      payload?.kind === "enrollment"
        ? await enrollmentAccess(ctx, args.organizationId, payload, args.action === "create")
        : undefined;
    const studyProject =
      payload?.kind === "studyVisit" &&
      studyVisitNeedsAuthorization(
        existing?.payload?.kind === "studyVisit" ? existing.payload : null,
        payload,
      )
        ? await studyVisitAccess(ctx, args.organizationId, payload)
        : undefined;
    let questionnaireProjectCompleted = false;
    if (payload?.kind === "questionnaire") {
      if (args.action === "create") {
        const { member, project } = await projectAccess(ctx, payload.projectClientId, "contribute");
        questionnaireProjectCompleted = project.status === "completed";
        if (member.organizationId !== args.organizationId) throw new ConvexError("ACCESS_DENIED");
      }
      // Correcting a clinic-owned record is a physician right independent of
      // current research participation. Its template binding still cannot move.
      if (
        existing?.payload?.kind === "questionnaire" &&
        (existing.payload.projectClientId !== payload.projectClientId ||
          existing.payload.formVersionClientId !== payload.formVersionClientId ||
          existing.payload.formClientId !== payload.formClientId ||
          existing.payload.formVersion !== payload.formVersion)
      )
        throw new ConvexError("FORM_VERSION_IMMUTABLE");
      const template = await ctx.db
        .query("studyForms")
        .withIndex("by_client", (q) => q.eq("clientId", payload.formVersionClientId))
        .unique();
      if (
        !template ||
        template.projectClientId !== payload.projectClientId ||
        template.formClientId !== payload.formClientId ||
        template.version !== payload.formVersion ||
        JSON.stringify(formDefinitionSchema.parse(template.definition)) !==
          JSON.stringify(payload.definition)
      )
        throw new ConvexError("INVALID_STUDY_FORM");
    }
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain:
        args.historyId !== undefined
          ? "clinical.record.v3"
          : args.expectedWriteId === undefined
            ? "clinical.record.v1"
            : "clinical.record.v2",
      ...(args.historyId !== undefined
        ? { historyId: args.historyId, expectedHistoryId: args.expectedHistoryId }
        : {}),
      ...(args.expectedWriteId === undefined ? {} : { expectedWriteId: args.expectedWriteId }),
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
      clientId: args.clientId,
      expectedRevision: args.expectedRevision,
      action: args.action,
      payload,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (args.action === "create" && payload?.kind === "questionnaire") {
      if (questionnaireProjectCompleted) throw new ConvexError("PROJECT_COMPLETED");
      const latest = await ctx.db
        .query("studyForms")
        .withIndex("by_form_version", (q) =>
          q.eq("projectClientId", payload.projectClientId).eq("formClientId", payload.formClientId),
        )
        .order("desc")
        .first();
      if (latest?.clientId !== payload.formVersionClientId || latest.status !== "published")
        throw new ConvexError("FORM_VERSION_OUTDATED");
    }
    if (
      args.action === "create"
        ? existing !== null || args.expectedRevision !== 0
        : !existing || existing.deleted || existing.revision !== args.expectedRevision
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      versionedWrite &&
      args.action !== "create" &&
      (!hasClinicalWriteId(existing?.payload) || existing.payload.writeId !== args.expectedWriteId)
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      args.action === "update" &&
      hasClinicalWriteId(existing?.payload) &&
      hasClinicalWriteId(payload) &&
      existing.payload.writeId === payload.writeId
    )
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    if (
      args.expectedHistoryId !== undefined &&
      (existing?.historyId ?? null) !== args.expectedHistoryId
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      args.historyId !== undefined &&
      (args.historyId === existing?.historyId ||
        (await ctx.db
          .query("clinicalVersions")
          .withIndex("by_client", (q) =>
            q.eq("organizationId", args.organizationId).eq("clientId", args.historyId!),
          )
          .unique()))
    )
      throw new ConvexError("INVALID_CLINICAL_RECORD");
    if (payload?.kind === "studyIssue") {
      try {
        validateStudyIssueWrite(
          existing?.payload?.kind === "studyIssue" ? existing.payload : null,
          payload,
          userId,
          Date.now(),
        );
      } catch (error) {
        throw new ConvexError(error instanceof Error ? error.message : "INVALID_CLINICAL_RECORD");
      }
      await checkStudyIssue(
        ctx,
        args.organizationId,
        args.patientClientId,
        existing?.payload?.kind === "studyIssue" ? existing.payload : null,
        payload,
      );
    }
    if (payload?.kind === "studyVisit") {
      if (args.action === "create" && payload.status !== "planned")
        throw new ConvexError("INVALID_VISIT_TRANSITION");
      if (payload.performedOn > new Date().toISOString().slice(0, 10))
        throw new ConvexError("INVALID_CLINICAL_DATE");
      if (studyProject)
        await checkStudyVisit(
          ctx,
          args.organizationId,
          args.patientClientId,
          payload,
          studyProject,
        );
    }
    if (payload?.kind === "enrollment") {
      try {
        validateEnrollmentChange(
          existing?.payload?.kind === "enrollment" ? existing.payload : null,
          payload,
          userId,
          Date.now(),
        );
      } catch (error) {
        throw new ConvexError(error instanceof Error ? error.message : "INVALID_ENROLLMENT");
      }
      if (args.action === "create" || payload.events.at(-1)?.status === "enrolled")
        await checkRecruitment(ctx, payload, enrollmentProject);
      if (args.action === "create") {
        const candidates = await ctx.db
          .query("clinicalRecords")
          .withIndex("by_patient_active", (q) =>
            q
              .eq("organizationId", args.organizationId)
              .eq("patientClientId", args.patientClientId)
              .eq("deleted", false),
          )
          .collect();
        if (
          candidates.some(
            (row) =>
              row.payload?.kind === "enrollment" &&
              row.payload.projectClientId === payload.projectClientId,
          )
        )
          throw new ConvexError("ENROLLMENT_EXISTS");
      }
    }
    if (existing?.payload && payload) {
      try {
        validateClinicalTransition(existing.payload, payload);
      } catch (error) {
        throw new ConvexError(error instanceof Error ? error.message : "INVALID_CLINICAL_RECORD");
      }
    }
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    const historyId = args.historyId ?? crypto.randomUUID();
    // Preserve the last pre-feature revision on its first update. Older content
    // that was already overwritten cannot be reconstructed retroactively.
    if (existing?.payload && !existing.historyId && args.action !== "delete") {
      const baselineId = legacyClinicalVersionId(existing.clientId, existing.revision);
      if (
        !(await ctx.db
          .query("clinicalVersions")
          .withIndex("by_client", (q) =>
            q.eq("organizationId", args.organizationId).eq("clientId", baselineId),
          )
          .unique())
      )
        await ctx.db.insert("clinicalVersions", {
          organizationId: args.organizationId,
          clientId: baselineId,
          recordClientId: args.clientId,
          patientClientId: args.patientClientId,
          revision: existing.revision,
          payload: existing.payload,
          recordedAt: existing.updatedAt,
          recordedBy: existing.updatedBy,
        });
    }
    if (payload)
      await ctx.db.insert("clinicalVersions", {
        organizationId: args.organizationId,
        clientId: historyId,
        recordClientId: args.clientId,
        patientClientId: args.patientClientId,
        revision,
        payload,
        recordedAt: now,
        recordedBy: userId,
      });
    if (args.action === "delete")
      await ctx.scheduler.runAfter(0, internal.clinicalRecords.eraseVersions, {
        organizationId: args.organizationId,
        patientClientId: args.patientClientId,
        recordClientId: args.clientId,
      });
    if (existing)
      await ctx.db.patch(existing._id, {
        payload,
        historyId,
        revision,
        deleted: args.action === "delete",
        updatedAt: now,
        updatedBy: userId,
      });
    else
      await ctx.db.insert("clinicalRecords", {
        organizationId: args.organizationId,
        patientClientId: args.patientClientId,
        clientId: args.clientId,
        historyId,
        payload,
        revision,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: userId,
      });
    await ctx.db.insert("clinicalAudit", {
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
      recordClientId: args.clientId,
      actorId: userId,
      action: args.action,
      revision,
      at: now,
    });
    return receipt.commit(revision);
  },
});

// Scheduled only from a committed patient deletion. Public access closes before
// cleanup; fixed-size batches avoid one unbounded write transaction.
export const erasePatientBatch = internalMutation({
  args: { organizationId: v.id("organizations"), patientClientId: v.string(), actorId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const patient = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.patientClientId),
      )
      .unique();
    if (!patient?.deleted) return;
    await ctx.scheduler.runAfter(0, internal.clinicalRecords.eraseVersions, {
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
    });
    const rows = await ctx.db
      .query("clinicalRecords")
      .withIndex("by_patient_active", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("patientClientId", args.patientClientId)
          .eq("deleted", false),
      )
      .take(50);
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        payload: null,
        deleted: true,
        revision: row.revision + 1,
        updatedAt: Date.now(),
        updatedBy: args.actorId,
      });
      await ctx.db.insert("clinicalAudit", {
        organizationId: args.organizationId,
        patientClientId: args.patientClientId,
        recordClientId: row.clientId,
        actorId: args.actorId,
        action: "patient-delete",
        revision: row.revision + 1,
        at: Date.now(),
      });
    }
    if (rows.length === 50)
      await ctx.scheduler.runAfter(0, internal.clinicalRecords.erasePatientBatch, args);
  },
});

export const reviewers = query({
  args: { actorId: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId, true);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return Promise.all(
      rows
        .filter((row) => row.active && row.verified && row.role === "doctor")
        .map(async (row) => {
          const profile = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", row.userId))
            .unique();
          return { userId: row.userId, displayName: profile?.displayName ?? row.userId };
        }),
    );
  },
});

export const versions = query({
  args: { actorId: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId, membership } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    if (membership.role !== "doctor") return [];
    const rows = await ctx.db
      .query("clinicalVersions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const patients = new Map<string, boolean>();
    const records = new Map<string, boolean>();
    for (const row of rows) {
      if (!patients.has(row.patientClientId)) {
        const patient = await ctx.db
          .query("patients")
          .withIndex("by_client", (q) =>
            q.eq("organizationId", args.organizationId).eq("clientId", row.patientClientId),
          )
          .unique();
        patients.set(row.patientClientId, Boolean(patient && !patient.deleted));
      }
      if (!records.has(row.recordClientId)) {
        const record = await ctx.db
          .query("clinicalRecords")
          .withIndex("by_client", (q) =>
            q.eq("organizationId", args.organizationId).eq("clientId", row.recordClientId),
          )
          .unique();
        records.set(
          row.recordClientId,
          Boolean(record && !record.deleted && record.patientClientId === row.patientClientId),
        );
      }
    }
    return rows
      .filter((row) => patients.get(row.patientClientId) && records.get(row.recordClientId))
      .map(({ _id, _creationTime, organizationId, ...row }) => ({ ...row, confirmed: true }));
  },
});
export const eraseVersions = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    patientClientId: v.string(),
    recordClientId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const patient = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.patientClientId),
      )
      .unique();
    if (!patient?.deleted) {
      if (!args.recordClientId) return;
      const record = await ctx.db
        .query("clinicalRecords")
        .withIndex("by_client", (q) =>
          q.eq("organizationId", args.organizationId).eq("clientId", args.recordClientId!),
        )
        .unique();
      if (!record?.deleted || record.patientClientId !== args.patientClientId) return;
    }
    const rows = args.recordClientId
      ? await ctx.db
          .query("clinicalVersions")
          .withIndex("by_record", (q) =>
            q.eq("organizationId", args.organizationId).eq("recordClientId", args.recordClientId!),
          )
          .take(50)
      : await ctx.db
          .query("clinicalVersions")
          .withIndex("by_patient", (q) =>
            q.eq("organizationId", args.organizationId).eq("patientClientId", args.patientClientId),
          )
          .take(50);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 50)
      await ctx.scheduler.runAfter(0, internal.clinicalRecords.eraseVersions, args);
  },
});
