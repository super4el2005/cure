import { v } from "convex/values";

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

export const publicDetails = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const key = ctx.db.normalizeId("organizations", id);
    const organization = key ? await ctx.db.get(key) : null;
    if (!organization?.published) return null;
    return {
      id: organization._id,
      name: organization.name,
      kind: organization.kind,
      country: organization.country,
      city: organization.city,
      description: organization.description,
    };
  },
});
