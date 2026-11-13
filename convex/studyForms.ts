import { ConvexError, v } from "convex/values";

import { mutation, query } from "@/convex/_generated/server";
import { actorId, organizationAccess } from "@/convex/lib/access";
import { operationReceipt, projectAccess, requireClientId } from "@/convex/lib/research";
import { formDefinition, formStatus } from "@/convex/schema";
import { formDefinitionSchema } from "@/src/lib/study-form-model";

export const mine = query({
  args: { actorId: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    await organizationAccess(ctx, args.organizationId);
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const rows = await Promise.all(
      members
        .filter((member) => member.active && member.organizationId === args.organizationId)
        .map((member) =>
          ctx.db
            .query("studyForms")
            .withIndex("by_project", (q) => q.eq("projectClientId", member.projectClientId))
            .collect(),
        ),
    );
    return rows.flat().map(({ _id, _creationTime, ...row }) => row);
  },
});
export const append = mutation({
  args: {
    actorId: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    projectClientId: v.string(),
    formClientId: v.string(),
    expectedVersion: v.number(),
    baseVersionClientId: v.union(v.string(), v.null()),
    definition: formDefinition,
    status: formStatus,
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId, project, member } = await projectAccess(ctx, args.projectClientId, true);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    if (member.organizationId !== args.organizationId) throw new ConvexError("ACCESS_DENIED");
    for (const id of [args.clientId, args.formClientId, args.projectClientId]) requireClientId(id);
    if (args.baseVersionClientId !== null) requireClientId(args.baseVersionClientId);
    const parsed = formDefinitionSchema.safeParse(args.definition);
    if (
      !parsed.success ||
      !Number.isSafeInteger(args.expectedVersion) ||
      args.expectedVersion < 0 ||
      (args.expectedVersion === 0) !== (args.baseVersionClientId === null) ||
      (args.expectedVersion === 0 && args.status === "retired")
    )
      throw new ConvexError("INVALID_STUDY_FORM");
    const receipt = await operationReceipt(ctx, userId, args.idempotencyKey, {
      domain: "form.append.v1",
      organizationId: args.organizationId,
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      formClientId: args.formClientId,
      expectedVersion: args.expectedVersion,
      baseVersionClientId: args.baseVersionClientId,
      definition: parsed.data,
      status: args.status,
    });
    if (receipt.previous) return { revision: receipt.previous.revision };
    if (project.status === "completed") throw new ConvexError("PROJECT_COMPLETED");
    const latest = await ctx.db
      .query("studyForms")
      .withIndex("by_form_version", (q) =>
        q.eq("projectClientId", args.projectClientId).eq("formClientId", args.formClientId),
      )
      .order("desc")
      .first();
    if (
      (latest?.version ?? 0) !== args.expectedVersion ||
      (latest?.clientId ?? null) !== args.baseVersionClientId
    )
      throw new ConvexError("REVISION_CONFLICT");
    if (
      await ctx.db
        .query("studyForms")
        .withIndex("by_client", (q) => q.eq("clientId", args.clientId))
        .unique()
    )
      throw new ConvexError("REVISION_CONFLICT");
    const version = args.expectedVersion + 1;
    await ctx.db.insert("studyForms", {
      clientId: args.clientId,
      projectClientId: args.projectClientId,
      formClientId: args.formClientId,
      version,
      baseVersionClientId: args.baseVersionClientId,
      definition: parsed.data,
      status: args.status,
      createdBy: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("researchAudit", {
      projectClientId: args.projectClientId,
      actorId: userId,
      action: "form.append",
      entityClientId: args.clientId,
      revision: version,
      at: Date.now(),
    });
    return receipt.commit(version);
  },
});
