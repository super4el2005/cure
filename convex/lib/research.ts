import { ConvexError } from "convex/values";

import type { QueryCtx, MutationCtx } from "@/convex/_generated/server";
import { actorId, organizationAccess } from "@/convex/lib/access";

export async function projectAccess(
  ctx: QueryCtx,
  clientId: string,
  write = false,
  allowArchived = false,
) {
  const userId = await actorId(ctx);
  const project = await ctx.db
    .query("projects")
    .withIndex("by_client", (q) => q.eq("clientId", clientId))
    .unique();
  const member = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_user", (q) => q.eq("projectClientId", clientId).eq("userId", userId))
    .unique();
  if (!project || !member?.active) throw new ConvexError("ACCESS_DENIED");
  await organizationAccess(ctx, member.organizationId);
  if (write && member.role !== "owner" && member.role !== "coordinator")
    throw new ConvexError("ACCESS_DENIED");
  if (write && project.status === "archived" && !allowArchived)
    throw new ConvexError("PROJECT_ARCHIVED");
  return { userId, project, member };
}
export async function operationReceipt(
  ctx: MutationCtx,
  userId: string,
  idempotencyKey: string,
  payload: unknown,
) {
  if (!idempotencyKey || idempotencyKey.length > 150) throw new ConvexError("INVALID_REQUEST");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const previous = await ctx.db
    .query("workspaceReceipts")
    .withIndex("by_owner_key", (q) => q.eq("userId", userId).eq("idempotencyKey", idempotencyKey))
    .unique();
  if (previous && previous.fingerprint !== fingerprint)
    throw new ConvexError("IDEMPOTENCY_KEY_REUSED");
  return {
    previous,
    async commit(revision: number) {
      await ctx.db.insert("workspaceReceipts", {
        userId,
        idempotencyKey,
        fingerprint,
        revision,
        at: Date.now(),
      });
      return { revision };
    },
  };
}
export function requireClientId(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))
    throw new ConvexError("INVALID_REQUEST");
}
