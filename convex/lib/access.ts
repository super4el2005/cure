import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import type { QueryCtx } from "@/convex/_generated/server";

export async function actorId(ctx: Pick<QueryCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("UNAUTHENTICATED");
  return identity.subject;
}
export async function organizationAccess(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  write = false,
) {
  const userId = await actorId(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_organization_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", userId),
    )
    .unique();
  if (
    !membership?.active ||
    !membership.verified ||
    membership.role === "admin" ||
    (write && membership.role !== "doctor")
  )
    throw new ConvexError("ACCESS_DENIED");
  return { userId, membership };
}
