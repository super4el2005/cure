import { ConvexError, v } from "convex/values";

import { query } from "@/convex/_generated/server";
import { projectAccess } from "@/convex/lib/research";
import { recruitmentJournal } from "@/src/lib/recruitment-journal";

// Aggregated recruitment per center for project members. The answer carries
// only counts and center identity; patient identifiers, event dates, reasons
// and consent documents never leave the clinic rows.
export const centers = query({
  args: { projectClientId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const records = await ctx.db
      .query("clinicalRecords")
      .withIndex("by_kind_active", (q) => q.eq("payload.kind", "enrollment").eq("deleted", false))
      .collect();
    const relevant = records.filter(
      (row) =>
        row.payload?.kind === "enrollment" && row.payload.projectClientId === args.projectClientId,
    );
    const organizations = new Map<string, { name: string; country: string; city: string }>();
    for (const organizationId of [...new Set(relevant.map((row) => row.organizationId))]) {
      const organization = await ctx.db.get(organizationId);
      if (organization)
        organizations.set(organizationId, {
          name: organization.name,
          country: organization.country,
          city: organization.city,
        });
    }
    return recruitmentJournal(relevant, organizations, args.projectClientId, Date.now());
  },
});
