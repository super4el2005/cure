import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { projectAccess, operationReceipt, requireClientId } from "@/convex/lib/research";
import { protocolFields } from "@/convex/schema";
import { protocolValuesSchema } from "@/src/lib/research-model";
export const history = query({
  args: { projectClientId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    return ctx.db
      .query("studyProtocols")
      .withIndex("by_project_version", (q) => q.eq("projectClientId", args.projectClientId))
      .order("desc")
      .collect();
  },
});
export const append = mutation({
  args: {
    actorId: v.string(),
    projectClientId: v.string(),
    clientId: v.string(),
    expectedVersion: v.number(),
    idempotencyKey: v.string(),
    values: v.object(protocolFields),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, true, true);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    const result = protocolValuesSchema.safeParse(args.values);
    if (!result.success || !Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0)
      throw new ConvexError("INVALID_PROTOCOL");
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "protocol.append.v1",
      projectClientId: args.projectClientId,
      clientId: args.clientId,
      expectedVersion: args.expectedVersion,
      values: result.data,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (access.project.status === "completed" || access.project.status === "archived")
      throw new ConvexError("PROJECT_COMPLETED");
    const latest = await ctx.db
      .query("studyProtocols")
      .withIndex("by_project_version", (q) => q.eq("projectClientId", args.projectClientId))
      .order("desc")
      .first();
    if ((latest?.version ?? 0) !== args.expectedVersion) throw new ConvexError("REVISION_CONFLICT");
    if (result.data.ethicsApproved && result.data.ethicsExpiresAt <= Date.now())
      throw new ConvexError("ETHICS_APPROVAL_REQUIRED");
    const existing = await ctx.db
      .query("studyProtocols")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing) throw new ConvexError("REVISION_CONFLICT");
    const version = args.expectedVersion + 1;
    await ctx.db.insert("studyProtocols", {
      ...result.data,
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      version,
      createdBy: access.userId,
      createdAt: Date.now(),
    });
    // A new protocol requires renewed preparation before public recruitment.
    if (access.project.status === "recruiting")
      await ctx.db.patch(access.project._id, {
        status: "preparing",
        revision: access.project.revision + 1,
        updatedAt: Date.now(),
        updatedBy: access.userId,
      });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: access.userId,
      action: "protocol.append",
      entityClientId: args.clientId,
      revision: version,
      at: Date.now(),
    });
    return receipt.commit(version);
  },
});
