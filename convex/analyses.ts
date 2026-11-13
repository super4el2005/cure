import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { operationReceipt, requireClientId } from "@/convex/lib/research";
import { analysisValues } from "@/convex/schema";
import { analysisValuesSchema } from "@/src/lib/saved-analysis-model";

export const list = query({
  args: { actorId: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    return (
      await ctx.db
        .query("savedAnalyses")
        .withIndex("by_owner", (q) =>
          q.eq("organizationId", args.organizationId).eq("userId", userId),
        )
        .collect()
    ).map(({ _id, _creationTime, organizationId, userId, ...row }) => row);
  },
});
export const apply = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    expectedRevision: v.number(),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    values: v.optional(analysisValues),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
      throw new ConvexError("INVALID_ANALYSIS");
    const parsed = args.action === "delete" ? null : analysisValuesSchema.safeParse(args.values);
    if (args.action === "delete" ? args.values !== undefined : !parsed?.success)
      throw new ConvexError("INVALID_ANALYSIS");
    const values = parsed?.success ? parsed.data : null;
    const previous = await ctx.db
      .query("savedAnalyses")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", args.organizationId).eq("clientId", args.clientId),
      )
      .unique();
    if (previous && previous.userId !== userId) throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "analysis.apply.v1",
      organizationId: args.organizationId,
      clientId: args.clientId,
      expectedRevision: args.expectedRevision,
      action: args.action,
      values,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (
      args.action === "create"
        ? previous !== null || args.expectedRevision !== 0
        : !previous || previous.deleted || previous.revision !== args.expectedRevision
    )
      throw new ConvexError("REVISION_CONFLICT");
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    if (previous)
      await ctx.db.patch(previous._id, {
        values,
        revision,
        deleted: args.action === "delete",
        updatedAt: now,
      });
    else
      await ctx.db.insert("savedAnalyses", {
        organizationId: args.organizationId,
        userId,
        clientId: args.clientId,
        values,
        revision,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      });
    await ctx.db.insert("analysisAudit", {
      organizationId: args.organizationId,
      actorId: userId,
      clientId: args.clientId,
      revision,
      action: args.action,
      at: now,
    });
    return receipt.commit(revision);
  },
});
