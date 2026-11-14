import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "@/convex/_generated/dataModel";
import { mutation, query } from "@/convex/_generated/server";
import type { QueryCtx, MutationCtx } from "@/convex/_generated/server";
import { actorId } from "@/convex/lib/access";
import { operationReceipt } from "@/convex/lib/research";
import { membershipRole, profession } from "@/convex/schema";
import {
  membershipChangeSchema,
  membershipRequestValuesSchema,
  membershipReviewSchema,
} from "@/src/lib/organization-membership-model";

async function actor(ctx: QueryCtx, expected: string) {
  const userId = await actorId(ctx);
  if (userId !== expected) throw new ConvexError("ACCOUNT_CHANGED");
  return userId;
}
async function member(ctx: QueryCtx, organizationId: Id<"organizations">, userId: string) {
  return ctx.db
    .query("memberships")
    .withIndex("by_organization_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", userId),
    )
    .unique();
}
async function administrator(ctx: QueryCtx, organizationId: Id<"organizations">, expected: string) {
  const userId = await actor(ctx, expected);
  const current = await member(ctx, organizationId, userId);
  if (
    !current?.active ||
    !current.verified ||
    current.role !== "admin" ||
    !(await ctx.db.get(organizationId))
  )
    throw new ConvexError("ACCESS_DENIED");
  return userId;
}
async function verifiedRole(
  ctx: QueryCtx,
  userId: string,
  role: "doctor" | "researcher" | "admin",
) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (role === "admin") return profile;
  if (!profile?.verified || profile.profession !== role)
    throw new ConvexError("PROFESSIONAL_VERIFICATION_REQUIRED");
  return profile;
}
function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ConvexError("INVALID_MEMBERSHIP");
}
function pageOptions(options: { numItems: number; cursor: string | null }) {
  if (!Number.isInteger(options.numItems) || options.numItems < 1 || options.numItems > 50)
    throw new ConvexError("INVALID_REQUEST");
  return { ...options, maximumRowsRead: 200 };
}
async function appendAudit(
  ctx: MutationCtx,
  value: Omit<Doc<"membershipAudit">, "_id" | "_creationTime" | "at">,
  reason?: string,
) {
  const auditId = await ctx.db.insert("membershipAudit", { ...value, at: Date.now() });
  if (reason) await ctx.db.insert("membershipDecisionNotes", { auditId, reason });
}

export const joinable = query({
  args: { actorId: v.string(), search: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await actor(ctx, args.actorId);
    const search = args.search.trim();
    if (search.length > 100) throw new ConvexError("INVALID_REQUEST");
    const query = search
      ? ctx.db
          .query("organizations")
          .withSearchIndex("search_name", (q) => q.search("name", search).eq("published", true))
      : ctx.db
          .query("organizations")
          .withIndex("by_published", (q) => q.eq("published", true))
          .order("desc");
    const result = await query.paginate(pageOptions(args.paginationOpts));
    return {
      ...result,
      actorId: userId,
      page: await Promise.all(
        result.page.map(async (row) => {
          const own = await ctx.db
            .query("membershipRequests")
            .withIndex("by_organization_user", (q) =>
              q.eq("organizationId", row._id).eq("userId", userId),
            )
            .unique();
          return {
            id: row._id,
            name: row.name,
            kind: row.kind,
            country: row.country,
            city: row.city,
            requestRevision: own?.revision ?? 0,
          };
        }),
      ),
    };
  },
});

export const mine = query({
  args: { actorId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const userId = await actor(ctx, args.actorId);
    const result = await ctx.db
      .query("membershipRequests")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(pageOptions(args.paginationOpts));
    return {
      ...result,
      actorId: userId,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...row,
          organizationName: (await ctx.db.get(row.organizationId))?.name ?? "",
        })),
      ),
    };
  },
});
export const members = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await administrator(ctx, args.organizationId, args.actorId);
    const result = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .paginate(pageOptions(args.paginationOpts));
    return {
      ...result,
      actorId: userId,
      page: await Promise.all(
        result.page.map(async (row) => {
          const profile = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", row.userId))
            .unique();
          return {
            id: row._id,
            userId: row.userId,
            revision: row.revision ?? 0,
            role: row.role,
            active: row.active,
            verified: row.verified,
            displayName: profile?.displayName ?? row.userId,
            profession: profile?.profession ?? null,
            qualificationVerified: profile?.verified ?? false,
          };
        }),
      ),
    };
  },
});
export const pending = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await administrator(ctx, args.organizationId, args.actorId);
    const result = await ctx.db
      .query("membershipRequests")
      .withIndex("by_organization_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "pending"),
      )
      .order("desc")
      .paginate(pageOptions(args.paginationOpts));
    return {
      ...result,
      actorId: userId,
      page: await Promise.all(
        result.page.map(async (row) => {
          const profile = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", row.userId))
            .unique();
          return {
            ...row,
            displayName: profile?.displayName ?? row.userId,
            profession: profile?.profession ?? null,
            qualificationVerified: profile?.verified ?? false,
          };
        }),
      ),
    };
  },
});
export const audit = query({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const userId = await administrator(ctx, args.organizationId, args.actorId);
    const result = await ctx.db
      .query("membershipAudit")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .paginate(pageOptions(args.paginationOpts));
    return {
      ...result,
      actorId: userId,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...row,
          reason:
            (
              await ctx.db
                .query("membershipDecisionNotes")
                .withIndex("by_audit", (q) => q.eq("auditId", row._id))
                .unique()
            )?.reason ?? "",
        })),
      ),
    };
  },
});
export const request = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    expectedRevision: v.number(),
    role: profession,
    message: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await actor(ctx, args.actorId);
    revision(args.expectedRevision);
    const organization = await ctx.db.get(args.organizationId);
    if (!organization?.published) throw new ConvexError("ORGANIZATION_UNAVAILABLE");
    await verifiedRole(ctx, userId, args.role);
    const parsed = membershipRequestValuesSchema.safeParse(args);
    if (!parsed.success) throw new ConvexError("INVALID_MEMBERSHIP");
    const values = parsed.data;
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "membership.request.v1",
      organizationId: args.organizationId,
      expectedRevision: args.expectedRevision,
      ...values,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    const previous = await ctx.db
      .query("membershipRequests")
      .withIndex("by_organization_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId),
      )
      .unique();
    if ((previous?.revision ?? 0) !== args.expectedRevision)
      throw new ConvexError("REVISION_CONFLICT");
    if (previous?.status === "pending") throw new ConvexError("MEMBERSHIP_REQUEST_PENDING");
    const membership = await member(ctx, args.organizationId, userId);
    if (membership?.active && membership.verified) throw new ConvexError("ALREADY_MEMBER");
    const nextRevision = args.expectedRevision + 1;
    const value = {
      ...values,
      organizationId: args.organizationId,
      userId,
      status: "pending" as const,
      revision: nextRevision,
      baseMembershipRevision: membership?.revision ?? 0,
      submittedAt: Date.now(),
      updatedAt: Date.now(),
      reviewedBy: null,
      reason: "",
    };
    const requestId = previous ? previous._id : await ctx.db.insert("membershipRequests", value);
    if (previous) await ctx.db.replace(previous._id, value);
    await appendAudit(ctx, {
      organizationId: args.organizationId,
      actorId: userId,
      targetUserId: userId,
      requestId,
      action: "requested",
      revision: nextRevision,
      previousRole: membership?.role ?? null,
      nextRole: values.role,
      previousActive: Boolean(membership?.active && membership.verified),
      nextActive: Boolean(membership?.active && membership.verified),
    });
    return receipt.commit(nextRevision);
  },
});
export const withdraw = mutation({
  args: {
    actorId: v.string(),
    requestId: v.id("membershipRequests"),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await actor(ctx, args.actorId);
    revision(args.expectedRevision);
    const request = await ctx.db.get(args.requestId);
    if (!request || request.userId !== userId) throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "membership.withdraw.v1",
      requestId: args.requestId,
      expectedRevision: args.expectedRevision,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (request.revision !== args.expectedRevision) throw new ConvexError("REVISION_CONFLICT");
    if (request.status !== "pending") throw new ConvexError("MEMBERSHIP_REQUEST_CLOSED");
    const next = request.revision + 1;
    await ctx.db.patch(request._id, {
      status: "withdrawn",
      revision: next,
      updatedAt: Date.now(),
      reviewedBy: userId,
    });
    await appendAudit(ctx, {
      organizationId: request.organizationId,
      actorId: userId,
      targetUserId: userId,
      requestId: request._id,
      action: "withdrawn",
      revision: next,
      previousRole: null,
      nextRole: request.role,
      previousActive: false,
      nextActive: false,
    });
    return receipt.commit(next);
  },
});
export const review = mutation({
  args: {
    actorId: v.string(),
    requestId: v.id("membershipRequests"),
    expectedRevision: v.number(),
    approved: v.boolean(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    await actor(ctx, args.actorId);
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new ConvexError("ACCESS_DENIED");
    const userId = await administrator(ctx, request.organizationId, args.actorId);
    revision(args.expectedRevision);
    if (request.userId === userId) throw new ConvexError("SELF_MEMBERSHIP_CHANGE_DENIED");
    const parsed = membershipReviewSchema.safeParse(args);
    if (!parsed.success) throw new ConvexError("INVALID_MEMBERSHIP");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "membership.review.v1",
      requestId: args.requestId,
      expectedRevision: args.expectedRevision,
      ...parsed.data,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (request.revision !== args.expectedRevision) throw new ConvexError("REVISION_CONFLICT");
    if (request.status !== "pending") throw new ConvexError("MEMBERSHIP_REQUEST_CLOSED");
    const membership = await member(ctx, request.organizationId, request.userId);
    let membershipId = membership?._id;
    if (args.approved) {
      await verifiedRole(ctx, request.userId, request.role);
      if ((membership?.revision ?? 0) !== request.baseMembershipRevision)
        throw new ConvexError("MEMBERSHIP_CHANGED");
      if (membership?.active && membership.verified) throw new ConvexError("ALREADY_MEMBER");
      const value = {
        organizationId: request.organizationId,
        userId: request.userId,
        role: request.role,
        active: true,
        verified: true,
        revision: (membership?.revision ?? 0) + 1,
      };
      if (membership) await ctx.db.patch(membership._id, value);
      else membershipId = await ctx.db.insert("memberships", value);
    }
    const next = request.revision + 1;
    await ctx.db.patch(request._id, {
      status: args.approved ? "approved" : "rejected",
      revision: next,
      reason: parsed.data.reason,
      updatedAt: Date.now(),
      reviewedBy: userId,
    });
    await appendAudit(
      ctx,
      {
        organizationId: request.organizationId,
        actorId: userId,
        targetUserId: request.userId,
        requestId: request._id,
        ...(membershipId ? { membershipId } : {}),
        action: args.approved ? "approved" : "rejected",
        revision: next,
        previousRole: membership?.role ?? null,
        nextRole: args.approved ? request.role : (membership?.role ?? request.role),
        previousActive: Boolean(membership?.active && membership.verified),
        nextActive: args.approved ? true : Boolean(membership?.active && membership.verified),
      },
      parsed.data.reason,
    );
    return receipt.commit(next);
  },
});
export const change = mutation({
  args: {
    actorId: v.string(),
    membershipId: v.id("memberships"),
    expectedRevision: v.number(),
    role: membershipRole,
    active: v.boolean(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    await actor(ctx, args.actorId);
    const membership = await ctx.db.get(args.membershipId);
    if (!membership) throw new ConvexError("ACCESS_DENIED");
    const userId = await administrator(ctx, membership.organizationId, args.actorId);
    revision(args.expectedRevision);
    if (membership.userId === userId) throw new ConvexError("SELF_MEMBERSHIP_CHANGE_DENIED");
    const parsed = membershipChangeSchema.safeParse(args);
    if (!parsed.success) throw new ConvexError("INVALID_MEMBERSHIP");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "membership.change.v1",
      membershipId: args.membershipId,
      expectedRevision: args.expectedRevision,
      ...parsed.data,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if ((membership.revision ?? 0) !== args.expectedRevision)
      throw new ConvexError("REVISION_CONFLICT");
    if (args.active) await verifiedRole(ctx, membership.userId, args.role);
    if (
      membership.active &&
      membership.verified &&
      membership.role === "admin" &&
      (!args.active || args.role !== "admin")
    ) {
      const admins = await ctx.db
        .query("memberships")
        .withIndex("by_organization_role_active", (q) =>
          q
            .eq("organizationId", membership.organizationId)
            .eq("role", "admin")
            .eq("active", true)
            .eq("verified", true),
        )
        .take(2);
      if (admins.length < 2) throw new ConvexError("LAST_ORGANIZATION_ADMIN");
    }
    const next = (membership.revision ?? 0) + 1;
    await ctx.db.patch(membership._id, {
      role: args.role,
      active: args.active,
      verified: args.active ? true : membership.verified,
      revision: next,
    });
    await appendAudit(
      ctx,
      {
        organizationId: membership.organizationId,
        actorId: userId,
        targetUserId: membership.userId,
        membershipId: membership._id,
        action: "changed",
        revision: next,
        previousRole: membership.role,
        nextRole: args.role,
        previousActive: membership.active && membership.verified,
        nextActive: args.active,
      },
      parsed.data.reason,
    );
    return receipt.commit(next);
  },
});
