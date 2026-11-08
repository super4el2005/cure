import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { actorId, organizationAccess } from "@/convex/lib/access";
import { publicResearch } from "@/convex/lib/public-research";
import { operationReceipt, projectAccess, requireClientId } from "@/convex/lib/research";
import { projectFields } from "@/convex/schema";
import { projectValuesSchema, validateResearchTransition } from "@/src/lib/research-model";

export const apply = mutation({
  args: {
    organizationId: v.id("organizations"),
    actorId: v.string(),
    clientId: v.string(),
    idempotencyKey: v.string(),
    expectedRevision: v.number(),
    values: v.object(projectFields),
  },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (args.actorId !== userId) throw new ConvexError("ACCOUNT_CHANGED");
    requireClientId(args.clientId);
    const parsed = projectValuesSchema.safeParse(args.values);
    if (!parsed.success) throw new ConvexError("INVALID_PROJECT");
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
      throw new ConvexError("INVALID_PROJECT");
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
      .unique();
    let role: "owner" | "coordinator" = "owner";
    if (existing) {
      const access = await projectAccess(ctx, args.clientId, true, true);
      if (existing.organizationId !== args.organizationId) throw new ConvexError("ACCESS_DENIED");
      role = access.member.role as "owner" | "coordinator";
    } else await organizationAccess(ctx, args.organizationId);
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "projects.apply.v1",
      organizationId: args.organizationId,
      clientId: args.clientId,
      expectedRevision: args.expectedRevision,
      values: parsed.data,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (existing ? existing.revision !== args.expectedRevision : args.expectedRevision !== 0)
      throw new ConvexError("REVISION_CONFLICT");
    if (!existing && (parsed.data.status !== "draft" || parsed.data.published))
      throw new ConvexError("INVALID_RESEARCH_TRANSITION");
    if (existing) {
      try {
        validateResearchTransition(existing.status, parsed.data.status, role);
      } catch {
        throw new ConvexError("INVALID_RESEARCH_TRANSITION");
      }
    }
    const organization = await ctx.db.get(args.organizationId);
    if (
      parsed.data.published &&
      (!organization?.published ||
        parsed.data.status === "draft" ||
        parsed.data.status === "archived")
    )
      throw new ConvexError("PROJECT_NOT_PUBLISHABLE");
    if (parsed.data.status === "recruiting") {
      const protocol = await ctx.db
        .query("studyProtocols")
        .withIndex("by_project_version", (q) => q.eq("projectClientId", args.clientId))
        .order("desc")
        .first();
      if (
        !protocol?.ethicsApproved ||
        !protocol.ethicsReference ||
        protocol.ethicsExpiresAt <= Date.now()
      )
        throw new ConvexError("ETHICS_APPROVAL_REQUIRED");
    }
    const revision = args.expectedRevision + 1;
    const now = Date.now();
    const values = { ...parsed.data, revision, updatedAt: now, updatedBy: userId };
    if (existing) await ctx.db.patch(existing._id, values);
    else {
      await ctx.db.insert("projects", {
        ...values,
        clientId: args.clientId,
        organizationId: args.organizationId,
        createdAt: now,
        createdBy: userId,
      });
      await ctx.db.insert("projectMembers", {
        clientId: `owner:${args.clientId}:${userId}`,
        projectClientId: args.clientId,
        userId,
        organizationId: args.organizationId,
        role: "owner",
        active: true,
        revision: 1,
      });
    }
    await ctx.db.insert("researchAudit", {
      projectClientId: args.clientId,
      actorId: userId,
      action: existing ? "project.update" : "project.create",
      entityClientId: args.clientId,
      revision,
      at: now,
    });
    return receipt.commit(revision);
  },
});
export const mine = query({
  args: { organizationId: v.id("organizations"), actorId: v.string() },
  handler: async (ctx, { organizationId, actorId: expectedActor }) => {
    const { userId } = await organizationAccess(ctx, organizationId);
    if (userId !== expectedActor) throw new ConvexError("ACCOUNT_CHANGED");
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const rows = await Promise.all(
      memberships
        .filter((member) => member.active && member.organizationId === organizationId)
        .map(async (member) => {
          const project = await ctx.db
            .query("projects")
            .withIndex("by_client", (q) => q.eq("clientId", member.projectClientId))
            .unique();
          return project ? { ...project, selfRole: member.role } : null;
        }),
    );
    return rows.filter((row) => row !== null);
  },
});
export const details = query({
  args: { clientId: v.string(), actorId: v.string() },
  handler: async (ctx, args) => {
    const access = await projectAccess(ctx, args.clientId);
    if (access.userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    return {
      ...access.project,
      selfRole: access.member.role,
      affiliationId: access.member.organizationId,
    };
  },
});
export const publicPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("projects")
      .withIndex("by_public_created", (q) => q.eq("published", true))
      .order("desc")
      .paginate(args.paginationOpts);
    const rows = await Promise.all(result.page.map((project) => publicResearch(ctx, project)));
    return { ...result, page: rows.filter((row) => row !== null) };
  },
});
export const publicDetails = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .unique();
    return project ? publicResearch(ctx, project) : null;
  },
});
