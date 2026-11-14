import { ConvexError, v } from "convex/values";

import { internal } from "@/convex/_generated/api";
import { internalMutation, mutation, query } from "@/convex/_generated/server";
import type { QueryCtx } from "@/convex/_generated/server";
import { actorId } from "@/convex/lib/access";
import { operationReceipt, requireClientId } from "@/convex/lib/research";
import { libraryEntry } from "@/convex/schema";
import { libraryEntrySchema } from "@/src/lib/library-model";

// A personal collection grants no institutional or clinical permissions.
async function owner(ctx: QueryCtx, expectedActor: string) {
  const userId = await actorId(ctx);
  if (userId !== expectedActor) throw new ConvexError("ACCOUNT_CHANGED");
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!profile || !["doctor", "researcher"].includes(profile.profession))
    throw new ConvexError("PROFILE_REQUIRED");
  return userId;
}
export const offlineLease = query({
  args: { actorId: v.string(), nonce: v.string() },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args.actorId);
    if (!args.nonce || args.nonce.length > 64) throw new ConvexError("INVALID_REQUEST");
    return { userId, purpose: "library" as const, expiresAt: Date.now() + 8 * 3600000 };
  },
});
export const list = query({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args.actorId);
    return (
      await ctx.db
        .query("libraryItems")
        .withIndex("by_owner", (q) => q.eq("userId", userId))
        .collect()
    ).map(({ _id, _creationTime, userId, ...row }) => row);
  },
});
export const versions = query({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args.actorId);
    const active = new Set(
      (
        await ctx.db
          .query("libraryItems")
          .withIndex("by_owner", (q) => q.eq("userId", userId))
          .collect()
      )
        .filter((row) => !row.deleted)
        .map((row) => row.clientId),
    );
    return (
      await ctx.db
        .query("libraryVersions")
        .withIndex("by_owner", (q) => q.eq("userId", userId))
        .collect()
    )
      .filter((row) => active.has(row.itemClientId))
      .map(({ _id, _creationTime, userId, ...row }) => row);
  },
});
export const apply = mutation({
  args: {
    actorId: v.string(),
    clientId: v.string(),
    writeId: v.string(),
    expectedWriteId: v.union(v.string(), v.null()),
    expectedRevision: v.number(),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    entry: v.optional(libraryEntry),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await owner(ctx, args.actorId);
    requireClientId(args.clientId);
    requireClientId(args.writeId);
    if (args.expectedWriteId !== null) requireClientId(args.expectedWriteId);
    if (
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0 ||
      (args.action === "create" ? args.expectedWriteId !== null : args.expectedWriteId === null)
    )
      throw new ConvexError("INVALID_LIBRARY");
    const parsed = args.action === "delete" ? null : libraryEntrySchema.safeParse(args.entry);
    if (args.action === "delete" ? args.entry !== undefined : !parsed?.success)
      throw new ConvexError("INVALID_LIBRARY");
    const entry = parsed?.success ? parsed.data : null;
    const previous = await ctx.db
      .query("libraryItems")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (previous && previous.userId !== userId) throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "library.apply.v1",
      clientId: args.clientId,
      writeId: args.writeId,
      expectedWriteId: args.expectedWriteId,
      expectedRevision: args.expectedRevision,
      action: args.action,
      entry,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (
      args.action === "create"
        ? previous !== null || args.expectedRevision !== 0
        : !previous ||
          previous.deleted ||
          previous.revision !== args.expectedRevision ||
          previous.writeId !== args.expectedWriteId
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (args.writeId === previous?.writeId) throw new ConvexError("INVALID_LIBRARY");
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    if (previous)
      await ctx.db.patch(previous._id, {
        writeId: args.writeId,
        entry,
        revision,
        deleted: args.action === "delete",
        updatedAt: now,
      });
    else
      await ctx.db.insert("libraryItems", {
        userId,
        clientId: args.clientId,
        writeId: args.writeId,
        entry,
        revision,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      });
    if (entry)
      await ctx.db.insert("libraryVersions", {
        userId,
        clientId: args.writeId,
        itemClientId: args.clientId,
        revision,
        entry,
        recordedAt: now,
        recordedBy: userId,
      });
    else
      await ctx.scheduler.runAfter(0, internal.library.eraseVersions, {
        clientId: args.clientId,
        userId,
      });
    await ctx.db.insert("libraryAudit", {
      actorId: userId,
      clientId: args.clientId,
      revision,
      action: args.action,
      at: now,
    });
    return receipt.commit(revision);
  },
});
export const eraseVersions = internalMutation({
  args: { clientId: v.string(), userId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query("libraryItems")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!row?.deleted || row.userId !== args.userId) return;
    const versions = await ctx.db
      .query("libraryVersions")
      .withIndex("by_item", (q) => q.eq("itemClientId", args.clientId))
      .take(50);
    for (const version of versions) await ctx.db.delete(version._id);
    if (versions.length === 50)
      await ctx.scheduler.runAfter(0, internal.library.eraseVersions, args);
  },
});
