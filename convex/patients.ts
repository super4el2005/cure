import { ConvexError, v } from "convex/values";

import { internal } from "@/convex/_generated/api";
import { internalMutation, mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { requireClientId } from "@/convex/lib/research";
import { patientFields } from "@/convex/schema";
import { activeResearchConsent, validateConsentTransition } from "@/src/lib/consent-model";
import {
  legacyPatientVersionId,
  patientVersionValuesSchema,
} from "@/src/lib/patient-version-model";

export const list = query({
  args: { organizationId: v.id("organizations"), actorId: v.string() },
  handler: async (ctx, { organizationId, actorId: expectedActor }) => {
    const { userId, membership } = await organizationAccess(ctx, organizationId);
    if (userId !== expectedActor) throw new ConvexError("ACCOUNT_CHANGED");
    const rows = await ctx.db
      .query("patients")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect();
    if (membership.role === "doctor") return rows;
    const permitted = await Promise.all(
      rows.map(async (row) => {
        const grant = await ctx.db
          .query("patientGrants")
          .withIndex("by_patient_user", (q) =>
            q
              .eq("organizationId", organizationId)
              .eq("patientClientId", row.clientId)
              .eq("userId", userId),
          )
          .unique();
        const consent = activeResearchConsent(row.consentHistory, userId, Date.now());
        if (
          !grant?.active ||
          grant.expiresAt <= Date.now() ||
          row.deleted ||
          !consent ||
          grant.consentVersion !== consent.version
        )
          return null;
        // Researchers never receive identity or unstructured notes via this query.
        return {
          clientId: row.clientId,
          organizationId,
          sex: consent.scope.includes("sex") ? row.sex : ("unknown" as const),
          diagnosisCodes: consent.scope.includes("diagnoses") ? row.diagnosisCodes : [],
          consentApproved: true,
          consentScope: consent.scope,
          consentHistory: [],
          revision: row.revision,
          updatedAt: row.updatedAt,
          accessExpiresAt: Math.min(grant.expiresAt, consent.expiresAt),
          deleted: false,
          fullName: "",
          birthDate: "",
          notes: "",
        };
      }),
    );
    return permitted.filter((row) => row !== null);
  },
});
export const apply = mutation({
  args: {
    organizationId: v.id("organizations"),
    actorId: v.string(),
    clientId: v.string(),
    idempotencyKey: v.string(),
    expectedRevision: v.number(),
    historyId: v.optional(v.string()),
    expectedHistoryId: v.optional(v.union(v.string(), v.null())),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    values: v.optional(v.object(patientFields)),
  },
  handler: async (ctx, args) => {
    // Check current authorization before returning a previous receipt as well.
    const { userId } = await organizationAccess(ctx, args.organizationId, true);
    if (args.actorId !== userId) throw new ConvexError("ACCOUNT_CHANGED");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        args.clientId,
      ) ||
      !args.idempotencyKey ||
      args.idempotencyKey.length > 150 ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new ConvexError("INVALID_PATIENT");
    if (args.historyId !== undefined) {
      requireClientId(args.historyId);
      if (args.expectedHistoryId === undefined) throw new ConvexError("INVALID_PATIENT");
    }
    if (args.expectedHistoryId !== undefined && args.historyId === undefined)
      throw new ConvexError("INVALID_PATIENT");
    if (args.expectedHistoryId !== undefined && args.expectedHistoryId !== null)
      requireClientId(args.expectedHistoryId);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          actorId: args.actorId,
          organizationId: args.organizationId,
          clientId: args.clientId,
          expectedRevision: args.expectedRevision,
          action: args.action,
          values: args.values
            ? {
                fullName: args.values.fullName,
                birthDate: args.values.birthDate,
                sex: args.values.sex,
                diagnosisCodes: args.values.diagnosisCodes,
                notes: args.values.notes,
                ...(args.values.consentHistory?.length
                  ? { consentHistory: args.values.consentHistory }
                  : {}),
              }
            : null,
          ...(args.historyId !== undefined
            ? { historyId: args.historyId, expectedHistoryId: args.expectedHistoryId }
            : {}),
        }),
      ),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const receipt = await ctx.db
      .query("operationReceipts")
      .withIndex("by_owner_key", (q) =>
        q.eq("userId", userId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ConvexError("IDEMPOTENCY_KEY_REUSED");
      return { revision: receipt.revision };
    }
    const existing = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.clientId),
      )
      .unique();
    if (
      args.action === "create"
        ? existing !== null || args.expectedRevision !== 0
        : !existing || existing.deleted || existing.revision !== args.expectedRevision
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      args.expectedHistoryId !== undefined &&
      (existing?.historyId ?? null) !== args.expectedHistoryId
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      args.historyId !== undefined &&
      (args.historyId === existing?.historyId ||
        (await ctx.db
          .query("patientVersions")
          .withIndex("by_client", (q) =>
            q.eq("organizationId", args.organizationId).eq("clientId", args.historyId!),
          )
          .unique()))
    )
      throw new ConvexError("INVALID_PATIENT");
    const historyId = args.historyId ?? crypto.randomUUID();
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    if (args.action !== "delete") {
      const data = args.values;
      if (
        !data ||
        !data.fullName.trim() ||
        data.fullName.length > 200 ||
        data.notes.length > 20000 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.birthDate) ||
        !Number.isFinite(Date.parse(data.birthDate)) ||
        new Date(data.birthDate).toISOString().slice(0, 10) !== data.birthDate ||
        data.birthDate > new Date(now).toISOString().slice(0, 10) ||
        data.diagnosisCodes.length > 100 ||
        data.diagnosisCodes.some((c) => !c.trim() || c.length > 50)
      )
        throw new ConvexError("INVALID_PATIENT");
      const consentHistory = data.consentHistory ?? existing?.consentHistory ?? [];
      let consentChange;
      try {
        consentChange = validateConsentTransition(
          existing?.consentHistory ?? [],
          consentHistory,
          userId,
          now,
        );
      } catch (error) {
        throw new ConvexError(error instanceof Error ? error.message : "INVALID_CONSENT");
      }
      if (consentChange?.kind === "granted") {
        for (const recipient of consentChange.recipients) {
          const member = await ctx.db
            .query("memberships")
            .withIndex("by_organization_user", (q) =>
              q.eq("organizationId", args.organizationId).eq("userId", recipient),
            )
            .unique();
          if (!member?.active || !member.verified || member.role !== "researcher")
            throw new ConvexError("INVALID_CONSENT_RECIPIENT");
        }
      }
      if (consentChange)
        await ctx.db.insert("patientAudit", {
          organizationId: args.organizationId,
          patientClientId: args.clientId,
          actorId: userId,
          action: consentChange.kind === "granted" ? "consent-granted" : "consent-withdrawn",
          revision,
          at: now,
        });
      const values = {
        ...data,
        consentHistory,
        fullName: data.fullName.trim(),
        revision,
        updatedAt: now,
        updatedBy: userId,
        deleted: false,
        historyId,
      };
      if (existing && !existing.historyId) {
        const baselineId = legacyPatientVersionId(existing.clientId, existing.revision);
        if (
          !(await ctx.db
            .query("patientVersions")
            .withIndex("by_client", (q) =>
              q.eq("organizationId", args.organizationId).eq("clientId", baselineId),
            )
            .unique())
        )
          await ctx.db.insert("patientVersions", {
            organizationId: args.organizationId,
            clientId: baselineId,
            patientClientId: args.clientId,
            revision: existing.revision,
            values: patientVersionValuesSchema.parse(existing),
            recordedAt: existing.updatedAt,
            recordedBy: existing.updatedBy,
          });
      }
      await ctx.db.insert("patientVersions", {
        organizationId: args.organizationId,
        clientId: historyId,
        patientClientId: args.clientId,
        revision,
        values: patientVersionValuesSchema.parse(values),
        recordedAt: now,
        recordedBy: userId,
      });
      if (existing) await ctx.db.patch(existing._id, values);
      else
        await ctx.db.insert("patients", {
          ...values,
          clientId: args.clientId,
          organizationId: args.organizationId,
        });
    } else if (existing) {
      await ctx.db.patch(existing._id, {
        historyId,
        consentHistory: [],
        fullName: "",
        birthDate: "",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
        deleted: true,
        revision,
        updatedAt: now,
        updatedBy: userId,
      });
      await ctx.scheduler.runAfter(0, internal.patients.eraseVersions, {
        organizationId: args.organizationId,
        patientClientId: args.clientId,
      });
      const archivedClinical = await ctx.db
        .query("clinicalVersions")
        .withIndex("by_patient", (q) =>
          q.eq("organizationId", args.organizationId).eq("patientClientId", args.clientId),
        )
        .first();
      if (archivedClinical)
        await ctx.scheduler.runAfter(0, internal.clinicalRecords.eraseVersions, {
          organizationId: args.organizationId,
          patientClientId: args.clientId,
        });
      const remaining = await ctx.db
        .query("clinicalRecords")
        .withIndex("by_patient_active", (q) =>
          q
            .eq("organizationId", args.organizationId)
            .eq("patientClientId", args.clientId)
            .eq("deleted", false),
        )
        .first();
      if (remaining)
        await ctx.scheduler.runAfter(0, internal.clinicalRecords.erasePatientBatch, {
          organizationId: args.organizationId,
          patientClientId: args.clientId,
          actorId: userId,
        });
    }
    await ctx.db.insert("operationReceipts", {
      userId,
      idempotencyKey: args.idempotencyKey,
      organizationId: args.organizationId,
      clientId: args.clientId,
      fingerprint,
      revision,
      completedAt: now,
    });
    await ctx.db.insert("patientAudit", {
      organizationId: args.organizationId,
      patientClientId: args.clientId,
      actorId: userId,
      action: args.action,
      revision,
      at: now,
    });
    return { revision };
  },
});

export const share = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    researcherId: v.string(),
    expiresAt: v.number(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId, true);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const patient = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.clientId),
      )
      .unique();
    const researcher = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.researcherId),
      )
      .unique();
    if (
      !patient ||
      patient.deleted ||
      !researcher?.verified ||
      !researcher.active ||
      researcher.role !== "researcher" ||
      !Number.isFinite(args.expiresAt) ||
      (args.active &&
        (args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 366 * 24 * 60 * 60 * 1000))
    )
      throw new ConvexError("INVALID_GRANT");
    const consent = activeResearchConsent(patient.consentHistory, args.researcherId, Date.now());
    if (args.active && !consent) throw new ConvexError("CONSENT_REQUIRED");
    const existing = await ctx.db
      .query("patientGrants")
      .withIndex("by_patient_user", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("patientClientId", args.clientId)
          .eq("userId", args.researcherId),
      )
      .unique();
    const values = {
      organizationId: args.organizationId,
      patientClientId: args.clientId,
      userId: args.researcherId,
      expiresAt: args.expiresAt,
      active: args.active,
      ...(args.active && consent ? { consentVersion: consent.version } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, values);
      return existing._id;
    }
    return ctx.db.insert("patientGrants", values);
  },
});

export const researchers = query({
  args: { organizationId: v.id("organizations"), actorId: v.string() },
  handler: async (ctx, { organizationId, actorId: expectedActor }) => {
    const { userId } = await organizationAccess(ctx, organizationId, true);
    if (userId !== expectedActor) throw new ConvexError("ACCOUNT_CHANGED");
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) => q.eq("organizationId", organizationId))
      .collect();
    return Promise.all(
      memberships
        .filter((m) => m.active && m.verified && m.role === "researcher")
        .map(async (m) => {
          const profile = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", m.userId))
            .unique();
          return { userId: m.userId, displayName: profile?.displayName ?? "" };
        }),
    );
  },
});

export const versions = query({
  args: { organizationId: v.id("organizations"), actorId: v.string() },
  handler: async (ctx, args) => {
    const { userId, membership } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    if (membership.role !== "doctor") return [];
    const rows = await ctx.db
      .query("patientVersions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const visible = new Set<string>();
    for (const clientId of new Set(rows.map((row) => row.patientClientId))) {
      const patient = await ctx.db
        .query("patients")
        .withIndex("by_client", (q) =>
          q.eq("organizationId", args.organizationId).eq("clientId", clientId),
        )
        .unique();
      if (patient && !patient.deleted) visible.add(clientId);
    }
    return rows
      .filter((row) => visible.has(row.patientClientId))
      .map(({ _id, _creationTime, organizationId, ...row }) => ({ ...row, confirmed: true }));
  },
});
export const eraseVersions = internalMutation({
  args: { organizationId: v.id("organizations"), patientClientId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const patient = await ctx.db
      .query("patients")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.patientClientId),
      )
      .unique();
    if (!patient?.deleted) return;
    const rows = await ctx.db
      .query("patientVersions")
      .withIndex("by_patient", (q) =>
        q.eq("organizationId", args.organizationId).eq("patientClientId", args.patientClientId),
      )
      .take(50);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 50) await ctx.scheduler.runAfter(0, internal.patients.eraseVersions, args);
  },
});
