import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { organizationAccess } from "@/convex/lib/access";
import { projectAccess, operationReceipt, requireClientId } from "@/convex/lib/research";
import { taskFields } from "@/convex/schema";
import { messageBodySchema, taskValuesSchema } from "@/src/lib/project-work-model";

export const saveTask = mutation({
  args: {
    actorId: v.string(),
    clientId: v.string(),
    projectClientId: v.string(),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
    values: v.object(taskFields),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, "contribute");
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    const parsed = taskValuesSchema.safeParse(args.values);
    if (
      !parsed.success ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new ConvexError("INVALID_TASK");
    const existing = await ctx.db
      .query("projectTasks")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    const manager = ["owner", "coordinator"].includes(access.member.role);
    if (
      existing &&
      (existing.projectClientId !== args.projectClientId ||
        (!manager && existing.createdBy !== access.userId && existing.assigneeId !== access.userId))
    )
      throw new ConvexError("ACCESS_DENIED");
    if (!manager && parsed.data.assigneeId !== (existing?.assigneeId ?? access.userId))
      throw new ConvexError("ACCESS_DENIED");
    if (!manager && existing?.status === "cancelled" && parsed.data.status !== "cancelled")
      throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "work.task.v1",
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      expectedRevision: args.expectedRevision,
      values: parsed.data,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if ((existing?.revision ?? 0) !== args.expectedRevision)
      throw new ConvexError("REVISION_CONFLICT");
    if (!existing && parsed.data.archived) throw new ConvexError("INVALID_TASK");
    if (
      existing &&
      existing.archived !== parsed.data.archived &&
      !manager &&
      existing.createdBy !== access.userId
    )
      throw new ConvexError("ACCESS_DENIED");
    // Unchanged historical assignments remain visible, even if that colleague left.
    if (!existing || parsed.data.assigneeId !== existing.assigneeId) {
      const assignee = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", args.projectClientId).eq("userId", parsed.data.assigneeId),
        )
        .unique();
      if (!assignee?.active || assignee.role === "viewer")
        throw new ConvexError("ASSIGNEE_UNAVAILABLE");
      const affiliation = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", assignee.organizationId).eq("userId", assignee.userId),
        )
        .unique();
      if (!affiliation?.active || !affiliation.verified || affiliation.role === "admin")
        throw new ConvexError("ASSIGNEE_UNAVAILABLE");
    }
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { ...parsed.data, revision, updatedAt: now });
    else
      await ctx.db.insert("projectTasks", {
        ...parsed.data,
        clientId: args.clientId,
        projectClientId: args.projectClientId,
        revision,
        createdBy: access.userId,
        createdAt: now,
        updatedAt: now,
      });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: access.userId,
      action: existing ? "task.update" : "task.create",
      entityClientId: args.clientId,
      revision,
      at: now,
    });
    return receipt.commit(revision);
  },
});
export const saveMessage = mutation({
  args: {
    actorId: v.string(),
    clientId: v.string(),
    projectClientId: v.string(),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, "contribute");
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    const parsed = messageBodySchema.safeParse(args.body);
    if (
      (args.action !== "delete" && !parsed.success) ||
      (args.action === "delete" && args.body !== "") ||
      !Number.isSafeInteger(args.expectedRevision) ||
      args.expectedRevision < 0
    )
      throw new ConvexError("INVALID_MESSAGE");
    const existing = await ctx.db
      .query("projectMessages")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    const manager = ["owner", "coordinator"].includes(access.member.role);
    if (
      existing &&
      (existing.projectClientId !== args.projectClientId ||
        (existing.createdBy !== access.userId && !(manager && args.action === "delete")))
    )
      throw new ConvexError("ACCESS_DENIED");
    const body = args.action === "delete" ? "" : messageBodySchema.parse(args.body);
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "work.message.v1",
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      action: args.action,
      expectedRevision: args.expectedRevision,
      body,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (
      args.action === "create"
        ? Boolean(existing) || args.expectedRevision !== 0
        : !existing || existing.revision !== args.expectedRevision
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (existing?.deleted) throw new ConvexError("MESSAGE_DELETED");
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    if (existing)
      await ctx.db.patch(existing._id, {
        body,
        deleted: args.action === "delete",
        revision,
        updatedAt: now,
      });
    else
      await ctx.db.insert("projectMessages", {
        clientId: args.clientId,
        projectClientId: args.projectClientId,
        body,
        deleted: false,
        revision,
        createdBy: access.userId,
        createdAt: now,
        updatedAt: now,
      });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: access.userId,
      action: `message.${args.action}`,
      entityClientId: args.clientId,
      revision,
      at: now,
    });
    return receipt.commit(revision);
  },
});
export const workspace = query({
  args: { organizationId: v.id("organizations"), actorId: v.string() },
  handler: async (ctx, args) => {
    const { userId } = await organizationAccess(ctx, args.organizationId);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const own = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const groups = await Promise.all(
      own
        .filter((member) => member.active && member.organizationId === args.organizationId)
        .map(async (member) => {
          const [tasks, messages] = await Promise.all([
            ctx.db
              .query("projectTasks")
              .withIndex("by_project", (q) => q.eq("projectClientId", member.projectClientId))
              .collect(),
            ctx.db
              .query("projectMessages")
              .withIndex("by_project", (q) => q.eq("projectClientId", member.projectClientId))
              .collect(),
          ]);
          return [
            ...tasks.map(({ _id, _creationTime, ...task }) => ({
              ...task,
              entity: "task" as const,
              key: `task:${task.clientId}`,
              delivery: "confirmed" as const,
            })),
            ...messages.map(({ _id, _creationTime, ...message }) => ({
              ...message,
              entity: "message" as const,
              key: `message:${message.clientId}`,
              delivery: "confirmed" as const,
            })),
          ];
        }),
    );
    return groups.flat();
  },
});
