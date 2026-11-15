import { ConvexError, v } from "convex/values";

import { query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { projectAccess } from "@/convex/lib/research";
import { deidentifiedRegistryRows } from "@/src/lib/registry-data";

// De-identified registry reading for project members. Study data is
// authorized by the study participation consent: a row is exposed only when
// the participant's latest enrollment decision in this project is enrolled or
// completed and the consent from the last enrolled event covers today.
// Participant codes and observation ids are deterministic pseudonyms over
// random UUIDs; names, notes, record ids and non-indicator answers never
// leave the clinic rows.
export const observations = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    formClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const latest = await ctx.db
      .query("studyForms")
      .withIndex("by_form", (q) => q.eq("formClientId", args.formClientId))
      .order("desc")
      .first();
    if (!latest?.definition.registry) throw new ConvexError("REGISTRY_NOT_FOUND");
    await projectAccess(ctx, latest.projectClientId);
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
        row.payload.formClientId === args.formClientId &&
        row.payload.projectClientId === latest.projectClientId &&
        row.organizationId === args.organizationId,
    );
    const enrollments = (
      await ctx.db
        .query("clinicalRecords")
        .withIndex("by_kind_active", (q) => q.eq("payload.kind", "enrollment").eq("deleted", false))
        .collect()
    ).filter(
      (row) =>
        row.payload?.kind === "enrollment" &&
        row.payload.projectClientId === latest.projectClientId &&
        row.organizationId === args.organizationId,
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
    const allowed = records.filter((row) => {
      const enrollment = eligible.get(row.patientClientId);
      return (
        enrollment &&
        ["enrolled", "completed"].includes(enrollment.status) &&
        enrollment.consentExpiresOn !== null &&
        enrollment.consentExpiresOn >= today
      );
    });
    const indicators = latest.definition.registry.indicators;
    return {
      projectClientId: latest.projectClientId,
      registry: latest.definition.registry,
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
