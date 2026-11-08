import { query } from "@/convex/_generated/server";
export const directory = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("organizations")
      .withIndex("by_published", (q) => q.eq("published", true))
      .take(200);
    return rows.map((o) => ({
      id: o._id,
      name: o.name,
      kind: o.kind,
      country: o.country,
      city: o.city,
      description: o.description,
    }));
  },
});
