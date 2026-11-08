import { ConvexError, v } from "convex/values";

import { query, mutation } from "@/convex/_generated/server";
import { actorId, organizationAccess } from "@/convex/lib/access";
import { projectAccess, operationReceipt, requireClientId } from "@/convex/lib/research";
const invitedRole = v.union(v.literal("coordinator"), v.literal("member"), v.literal("viewer"));

export const members = query({
  args: { projectClientId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectClientId", args.projectClientId))
      .collect();
    return Promise.all(
      members
        .filter((m) => m.active)
        .map(async (member) => {
          const profile = await ctx.db
            .query("profiles")
            .withIndex("by_user", (q) => q.eq("userId", member.userId))
            .unique();
          const organization = await ctx.db.get(member.organizationId);
          return {
            clientId: member.clientId,
            userId: member.userId,
            role: member.role,
            organization: organization?.name ?? "",
            displayName: profile?.displayName ?? "",
            revision: member.revision,
          };
        }),
    );
  },
});
export const invitations = query({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const invites = await ctx.db
      .query("collaborationInvites")
      .withIndex("by_recipient", (q) => q.eq("inviteeId", userId))
      .collect();
    return Promise.all(
      invites.map(async (invite) => {
        const project = await ctx.db
          .query("projects")
          .withIndex("by_client", (q) => q.eq("clientId", invite.projectClientId))
          .unique();
        return {
          ...invite,
          projectTitle: project?.title ?? "",
          projectStatus: project?.status ?? "archived",
        };
      }),
    );
  },
});
export const projectInvitations = query({
  args: { projectClientId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, true);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    return ctx.db
      .query("collaborationInvites")
      .withIndex("by_project", (q) => q.eq("projectClientId", args.projectClientId))
      .collect();
  },
});
export const invite = mutation({
  args: {
    actorId: v.string(),
    projectClientId: v.string(),
    clientId: v.string(),
    targetProfileId: v.id("profiles"),
    role: invitedRole,
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, true, true);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    if (args.role === "coordinator" && access.member.role !== "owner")
      throw new ConvexError("ACCESS_DENIED");
    requireClientId(args.clientId);
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "team.invite.v1",
      projectClientId: args.projectClientId,
      clientId: args.clientId,
      profileId: args.targetProfileId,
      role: args.role,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (access.project.status === "archived" || access.project.status === "completed")
      throw new ConvexError("PROJECT_COMPLETED");
    const profile = await ctx.db.get(args.targetProfileId);
    if (!profile?.verified || !profile.published || profile.userId === access.userId)
      throw new ConvexError("INVITEE_UNAVAILABLE");
    const member = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_user", (q) =>
        q.eq("projectClientId", args.projectClientId).eq("userId", profile.userId),
      )
      .unique();
    if (member?.active) throw new ConvexError("ALREADY_MEMBER");
    const previous = await ctx.db
      .query("collaborationInvites")
      .withIndex("by_project", (q) => q.eq("projectClientId", args.projectClientId))
      .collect();
    if (
      previous.some(
        (invite) =>
          invite.inviteeId === profile.userId &&
          invite.status === "pending" &&
          invite.expiresAt > Date.now(),
      )
    )
      throw new ConvexError("INVITE_ALREADY_PENDING");
    if (
      await ctx.db
        .query("collaborationInvites")
        .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
        .unique()
    )
      throw new ConvexError("REVISION_CONFLICT");
    await ctx.db.insert("collaborationInvites", {
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      inviteeId: profile.userId,
      inviterId: access.userId,
      role: args.role,
      status: "pending",
      expiresAt: Date.now() + 7 * 86400000,
      revision: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: access.userId,
      action: "team.invite",
      entityClientId: args.clientId,
      revision: 1,
      at: Date.now(),
    });
    return receipt.commit(1);
  },
});
export const respond = mutation({
  args: {
    actorId: v.string(),
    clientId: v.string(),
    organizationId: v.optional(v.id("organizations")),
    decision: v.union(v.literal("accept"), v.literal("decline")),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const invite = await ctx.db
      .query("collaborationInvites")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!invite || invite.inviteeId !== userId) throw new ConvexError("ACCESS_DENIED");
    if (args.decision === "accept") {
      if (!args.organizationId) throw new ConvexError("AFFILIATION_REQUIRED");
      await organizationAccess(ctx, args.organizationId);
    }
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "team.respond.v1",
      clientId: args.clientId,
      organizationId: args.organizationId ?? null,
      decision: args.decision,
      expectedRevision: args.expectedRevision,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (invite.revision !== args.expectedRevision) throw new ConvexError("REVISION_CONFLICT");
    if (invite.status !== "pending") throw new ConvexError("INVITE_NOT_PENDING");
    const revision = invite.revision + 1;
    if (args.decision === "accept") {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_client", (q) => q.eq("clientId", invite.projectClientId))
        .unique();
      if (
        !project ||
        project.status === "completed" ||
        project.status === "archived" ||
        invite.expiresAt <= Date.now()
      )
        throw new ConvexError("INVITE_EXPIRED");
      const existing = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", invite.projectClientId).eq("userId", userId),
        )
        .unique();
      if (existing?.active || existing?.role === "owner") throw new ConvexError("ALREADY_MEMBER");
      if (existing)
        await ctx.db.patch(existing._id, {
          active: true,
          organizationId: args.organizationId!,
          role: invite.role,
          revision: existing.revision + 1,
        });
      else
        await ctx.db.insert("projectMembers", {
          clientId: `invite:${invite.clientId}:${userId}`,
          projectClientId: invite.projectClientId,
          userId,
          organizationId: args.organizationId!,
          role: invite.role,
          active: true,
          revision: 1,
        });
    }
    await ctx.db.patch(invite._id, {
      status: args.decision === "accept" ? "accepted" : "declined",
      revision,
    });
    await ctx.db.insert("researchAudit", {
      projectClientId: invite.projectClientId,
      actorId: userId,
      action: `team.${args.decision}`,
      entityClientId: invite.clientId,
      revision,
      at: Date.now(),
    });
    return receipt.commit(revision);
  },
});
export const revokeInvite = mutation({
  args: {
    actorId: v.string(),
    clientId: v.string(),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("collaborationInvites")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!invite) throw new ConvexError("ACCESS_DENIED");
    const access = await projectAccess(ctx, invite.projectClientId, true, true);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    if (invite.role === "coordinator" && access.member.role !== "owner")
      throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "team.revokeInvite.v1",
      clientId: args.clientId,
      expectedRevision: args.expectedRevision,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (invite.revision !== args.expectedRevision) throw new ConvexError("REVISION_CONFLICT");
    if (invite.status !== "pending") throw new ConvexError("INVITE_NOT_PENDING");
    const revision = invite.revision + 1;
    await ctx.db.patch(invite._id, { status: "revoked", revision });
    await ctx.db.insert("researchAudit", {
      projectClientId: invite.projectClientId,
      actorId: access.userId,
      action: "team.revokeInvite",
      entityClientId: args.clientId,
      revision,
      at: Date.now(),
    });
    return receipt.commit(revision);
  },
});
export const setMember = mutation({
  args: {
    actorId: v.string(),
    projectClientId: v.string(),
    targetUserId: v.string(),
    role: invitedRole,
    active: v.boolean(),
    expectedRevision: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.projectClientId, true, true);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const target = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_user", (q) =>
        q.eq("projectClientId", args.projectClientId).eq("userId", args.targetUserId),
      )
      .unique();
    if (
      !target ||
      target.role === "owner" ||
      (access.member.role !== "owner" &&
        (target.role === "coordinator" || args.role === "coordinator"))
    )
      throw new ConvexError("ACCESS_DENIED");
    const receipt = await operationReceipt(ctx, access.userId, args.idempotencyKey, {
      domain: "team.setMember.v1",
      projectClientId: args.projectClientId,
      targetUserId: args.targetUserId,
      role: args.role,
      active: args.active,
      expectedRevision: args.expectedRevision,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (target.revision !== args.expectedRevision) throw new ConvexError("REVISION_CONFLICT");
    if (args.active && !target.active) throw new ConvexError("NEW_INVITATION_REQUIRED");
    const revision = target.revision + 1;
    await ctx.db.patch(target._id, { active: args.active, role: args.role, revision });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: access.userId,
      action: args.active ? "team.changeRole" : "team.removeMember",
      entityClientId: target.clientId,
      revision,
      at: Date.now(),
    });
    return receipt.commit(revision);
  },
});
