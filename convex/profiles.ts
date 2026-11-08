import { ConvexError, v } from "convex/values";

import { query, mutation } from "@/convex/_generated/server";
import { actorId } from "@/convex/lib/access";
import { profession } from "@/convex/schema";

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await actorId(ctx);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      userId,
      profile,
      memberships: await Promise.all(
        memberships
          .filter((m) => m.active && m.verified)
          .map(async (m) => ({ ...m, organization: await ctx.db.get(m.organizationId) })),
      ),
    };
  },
});
export const save = mutation({
  args: {
    actorId: v.string(),
    displayName: v.string(),
    profession,
    specialty: v.string(),
    interests: v.array(v.string()),
    languages: v.array(v.string()),
    bio: v.string(),
    published: v.boolean(),
  },
  handler: async (ctx, { actorId: expectedActor, ...args }) => {
    const userId = await actorId(ctx);
    if (userId !== expectedActor) throw new ConvexError("ACCOUNT_CHANGED");
    if (
      !args.displayName.trim() ||
      args.displayName.length > 150 ||
      args.bio.length > 3000 ||
      args.specialty.length > 200 ||
      args.interests.length > 30 ||
      args.languages.length > 20 ||
      [...args.interests, ...args.languages].some((x) => !x.trim() || x.length > 100)
    )
      throw new ConvexError("INVALID_PROFILE");
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing?.verified && existing.profession !== args.profession)
      throw new ConvexError("VERIFIED_ROLE_CHANGE_REQUIRES_REVIEW");
    const values = { ...args, displayName: args.displayName.trim(), updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, values);
      return existing._id;
    }
    return ctx.db.insert("profiles", { ...values, userId, verified: false });
  },
});
export const directory = query({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_public", (q) => q.eq("published", true).eq("verified", true))
      .take(200);
    return profiles.map((p) => ({
      id: p._id,
      displayName: p.displayName,
      profession: p.profession,
      specialty: p.specialty,
      interests: p.interests,
      languages: p.languages,
      bio: p.bio,
      verified: p.verified,
    }));
  },
});

// A new nonce obtains a fresh lease instead of renewing from a cached snapshot.
export const offlineLease = query({
  args: { organizationId: v.id("organizations"), nonce: v.string() },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (args.nonce.length > 64) throw new ConvexError("INVALID_REQUEST");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId),
      )
      .unique();
    if (!membership?.active || !membership.verified || membership.role === "admin")
      throw new ConvexError("ACCESS_DENIED");
    return {
      userId,
      organizationId: args.organizationId,
      role: membership.role,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    };
  },
});

export const publicDetails = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const key = ctx.db.normalizeId("profiles", id);
    const profile = key ? await ctx.db.get(key) : null;
    if (!profile?.published || !profile.verified) return null;
    return {
      id: profile._id,
      displayName: profile.displayName,
      profession: profile.profession,
      specialty: profile.specialty,
      interests: profile.interests,
      languages: profile.languages,
      bio: profile.bio,
      verified: profile.verified,
    };
  },
});
