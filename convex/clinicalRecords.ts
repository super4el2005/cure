import { ConvexError, v } from "convex/values";

import { internal } from "@/convex/_generated/api";
import { internalMutation, mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { operationReceipt, requireClientId } from "@/convex/lib/research";
import { clinicalPayload } from "@/convex/schema";
import { clinicalPayloadSchema, validateClinicalTransition } from "@/src/lib/clinical-record-model";

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
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "clinical.record.v1",
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
      clientId: args.clientId,
      expectedRevision: args.expectedRevision,
      action: args.action,
      payload,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (
      args.action === "create"
        ? existing !== null || args.expectedRevision !== 0
        : !existing || existing.deleted || existing.revision !== args.expectedRevision
    )
      throw new ConvexError("REVISION_CONFLICT");
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
