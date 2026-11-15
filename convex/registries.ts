import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { projectAccess } from "@/convex/lib/research";
import { deidentifiedRegistryRows, registryParticipantCode } from "@/src/lib/registry-data";

async function registryFamily(ctx: Parameters<typeof organizationAccess>[0], formClientId: string) {
  const latest = await ctx.db
    .query("studyForms")
    .withIndex("by_form", (q) => q.eq("formClientId", formClientId))
    .order("desc")
    .first();
  if (!latest?.definition.registry) throw new ConvexError("REGISTRY_NOT_FOUND");
  return latest;
}
// Study data is authorized by the study participation consent: a record is
// eligible only when the participant's latest enrollment decision in this
// project is enrolled or completed and the consent from the last enrolled
// event covers today.
async function eligibleRecords(
  ctx: Parameters<typeof organizationAccess>[0],
  organizationId: Parameters<typeof organizationAccess>[1],
  projectClientId: string,
  formClientId: string,
) {
  const records = (
    await ctx.db
      .query("clinicalRecords")
      .withIndex("by_kind_active", (q) =>
        q.eq("payload.kind", "questionnaire").eq("deleted", false),
      )
      .collect()
  ).filter(
    (row) =>
      row.payload?.kind === "questionnaire" &&
      row.payload.formClientId === formClientId &&
      row.payload.projectClientId === projectClientId &&
      row.organizationId === organizationId,
  );
  const enrollments = (
    await ctx.db
      .query("clinicalRecords")
      .withIndex("by_kind_active", (q) => q.eq("payload.kind", "enrollment").eq("deleted", false))
      .collect()
  ).filter(
    (row) =>
      row.payload?.kind === "enrollment" &&
      row.payload.projectClientId === projectClientId &&
      row.organizationId === organizationId,
  );
  const today = new Date().toISOString().slice(0, 10);
  const eligible = new Map<string, { status: string; consentExpiresOn: string | null }>();
  for (const row of enrollments) {
    const payload = row.payload!;
    if (payload.kind !== "enrollment") continue;
    const decision = payload.events.at(-1)!;
    const consent = payload.events.findLast((event) => event.status === "enrolled")?.consent;
    eligible.set(row.patientClientId, {
      status: decision.status,
      consentExpiresOn: consent?.expiresOn ?? null,
    });
  }
  return records.filter((row) => {
    const enrollment = eligible.get(row.patientClientId);
    return (
      enrollment &&
      ["enrolled", "completed"].includes(enrollment.status) &&
      enrollment.consentExpiresOn !== null &&
      enrollment.consentExpiresOn >= today
    );
  });
}
// De-identified registry reading for project members. Participant codes and
// observation ids are deterministic pseudonyms over random UUIDs; names,
// notes, record ids and non-indicator answers never leave the clinic rows.
export const observations = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    formClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const latest = await registryFamily(ctx, args.formClientId);
    const registry = latest.definition.registry!;
    await projectAccess(ctx, latest.projectClientId);
    const allowed = await eligibleRecords(
      ctx,
      args.organizationId,
      latest.projectClientId,
      args.formClientId,
    );
    const indicators = registry.indicators;
    return {
      projectClientId: latest.projectClientId,
      registry,
      title: latest.definition.title,
      version: latest.version,
      fields: latest.definition.fields.filter((field) => indicators.includes(field.id)),
      rows: deidentifiedRegistryRows(
        allowed,
        latest.projectClientId,
        args.formClientId,
        indicators,
      ),
    };
  },
});
// Clarification requests let a project member ask the physician about a
// de-identified observation without gaining any right to change the patient
// record. The request references only pseudonymous pointers; the physician
// resolves the participant locally. Online-only communication: requests are
// not clinical records and are not queued offline.
export const raise = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    formClientId: v.string(),
    clientId: v.string(),
    participantCode: v.string(),
    occurredOn: v.string(),
    formVersion: v.number(),
    fieldId: v.union(v.string(), v.null()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const text = args.text.trim();
    if (!text || text.length > 2000) throw new ConvexError("INVALID_REGISTRY_QUERY");
    const latest = await registryFamily(ctx, args.formClientId);
    await projectAccess(ctx, latest.projectClientId);
    const registry = latest.definition.registry!;
    if (args.fieldId !== null && !registry.indicators.includes(args.fieldId))
      throw new ConvexError("INVALID_REGISTRY_QUERY");
    const existing = await ctx.db
      .query("registryQueries")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing) return { clientId: existing.clientId, status: existing.status };
    const allowed = await eligibleRecords(
      ctx,
      args.organizationId,
      latest.projectClientId,
      args.formClientId,
    );
    const match = allowed.some((row) => {
      if (row.payload?.kind !== "questionnaire" || row.payload.status !== "final") return false;
      return (
        registryParticipantCode(latest.projectClientId, row.patientClientId) ===
          args.participantCode &&
        row.payload.occurredOn === args.occurredOn &&
        row.payload.formVersion === args.formVersion
      );
    });
    if (!match) throw new ConvexError("REGISTRY_OBSERVATION_NOT_FOUND");
    await ctx.db.insert("registryQueries", {
      clientId: args.clientId,
      organizationId: args.organizationId,
      projectClientId: latest.projectClientId,
      formClientId: args.formClientId,
      participantCode: args.participantCode,
      occurredOn: args.occurredOn,
      formVersion: args.formVersion,
      fieldId: args.fieldId,
      text,
      status: "open",
      createdBy: userId,
      createdAt: Date.now(),
      resolvedBy: null,
      resolvedAt: null,
      resolution: "",
    });
    return { clientId: args.clientId, status: "open" as const };
  },
});
export const queries = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    formClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId, membership } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const rows =
      membership.role === "doctor"
        ? await ctx.db
            .query("registryQueries")
            .withIndex("by_org_form", (q) =>
              q.eq("organizationId", args.organizationId).eq("formClientId", args.formClientId),
            )
            .collect()
        : await ctx.db
            .query("registryQueries")
            .withIndex("by_requester", (q) =>
              q.eq("createdBy", userId).eq("formClientId", args.formClientId),
            )
            .collect();
    return rows
      .filter((row) => row.organizationId === args.organizationId)
      .sort((a, b) => b.createdAt - a.createdAt || a.clientId.localeCompare(b.clientId))
      .map(({ _id, _creationTime, ...row }) => row);
  },
});
export const resolve = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    status: v.union(v.literal("resolved"), v.literal("dismissed")),
    resolution: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId, true);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const resolution = args.resolution.trim();
    if (resolution.length > 2000 || (args.status === "resolved" && !resolution))
      throw new ConvexError("INVALID_REGISTRY_QUERY");
    const row = await ctx.db
      .query("registryQueries")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!row || row.organizationId !== args.organizationId)
      throw new ConvexError("REGISTRY_QUERY_NOT_FOUND");
    if (row.status !== "open") return { clientId: row.clientId, status: row.status };
    await ctx.db.patch(row._id, {
      status: args.status,
      resolvedBy: userId,
      resolvedAt: Date.now(),
      resolution,
    });
    return { clientId: row.clientId, status: args.status };
  },
});
