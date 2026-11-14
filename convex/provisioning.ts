import { ConvexError, v } from "convex/values";

import { internalMutation } from "@/convex/_generated/server";
import { membershipRole } from "@/convex/schema";

// Internal only: professional verification is never granted by a browser form.
export const createOrganization = internalMutation({
  args: {
    name: v.string(),
    kind: v.union(
      v.literal("clinic"),
      v.literal("university"),
      v.literal("hospital"),
      v.literal("laboratory"),
    ),
    country: v.string(),
    city: v.string(),
    description: v.string(),
    published: v.boolean(),
  },
  handler: (ctx, args) => ctx.db.insert("organizations", args),
});
export const approveMembership = internalMutation({
  args: { userId: v.string(), organizationId: v.id("organizations"), role: membershipRole },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.organizationId))) throw new ConvexError("ORGANIZATION_NOT_FOUND");
    const previous = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId),
      )
      .unique();
    if (previous) {
      await ctx.db.patch(previous._id, {
        role: args.role,
        verified: true,
        active: true,
        revision: (previous.revision ?? 0) + 1,
      });
      return previous._id;
    }
    return ctx.db.insert("memberships", { ...args, verified: true, active: true, revision: 1 });
  },
});
export const verifyProfile = internalMutation({
  args: { userId: v.string(), verified: v.boolean() },
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!profile) throw new ConvexError("PROFILE_NOT_FOUND");
    await ctx.db.patch(profile._id, { verified: args.verified });
  },
});
