import { ConvexError, v } from "convex/values";

import { internal } from "@/convex/_generated/api";
import { internalMutation, mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { enrollmentAccess, checkRecruitment } from "@/convex/lib/enrollment";
import { operationReceipt, projectAccess, requireClientId } from "@/convex/lib/research";
import { studyVisitAccess, checkStudyVisit } from "@/convex/lib/studyVisit";
import { clinicalPayload } from "@/convex/schema";
import { clinicalPayloadSchema, validateClinicalTransition } from "@/src/lib/clinical-record-model";
import { validateEnrollmentChange } from "@/src/lib/study-enrollment-model";
import { formDefinitionSchema } from "@/src/lib/study-form-model";
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
    const versionedWrite =
      payload?.kind === "questionnaire" ||
      existing?.payload?.kind === "questionnaire" ||
      payload?.kind === "enrollment" ||
      existing?.payload?.kind === "enrollment" ||
      payload?.kind === "studyVisit" ||
      existing?.payload?.kind === "studyVisit";
    if (args.expectedWriteId !== undefined && args.expectedWriteId !== null)
      requireClientId(args.expectedWriteId);
    if (
      versionedWrite &&
      (args.expectedWriteId === undefined ||
        (args.action === "create" ? args.expectedWriteId !== null : args.expectedWriteId === null))
    )
      throw new ConvexError("INVALID_CLINICAL_RECORD");
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
      domain: args.expectedWriteId === undefined ? "clinical.record.v1" : "clinical.record.v2",
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
      ((existing?.payload?.kind !== "questionnaire" &&
        existing?.payload?.kind !== "enrollment" &&
        existing?.payload?.kind !== "studyVisit") ||
        existing.payload.writeId !== args.expectedWriteId)
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      args.action === "update" &&
      (existing?.payload?.kind === "questionnaire" ||
        existing?.payload?.kind === "enrollment" ||
        existing?.payload?.kind === "studyVisit") &&
      (payload?.kind === "questionnaire" ||
        payload?.kind === "enrollment" ||
        payload?.kind === "studyVisit") &&
      existing.payload.writeId === payload.writeId
    )
      throw new ConvexError("INVALID_CLINICAL_RECORD");
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
    if (existing)
      await ctx.db.patch(existing._id, {
        payload,
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
