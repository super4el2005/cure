import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import type { MutationCtx } from "@/convex/_generated/server";
import { projectAccess } from "@/convex/lib/research";
import type { EnrollmentPayload } from "@/src/lib/study-enrollment-model";

// Starting recruitment requires project rights; documenting refusal/withdrawal
// remains the treating clinic's responsibility after project membership ends.
export async function enrollmentAccess(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  payload: EnrollmentPayload,
  create: boolean,
) {
  if (!create && payload.events.at(-1)?.status !== "enrolled") return;
  const { member, project } = await projectAccess(ctx, payload.projectClientId, "contribute");
  if (member.organizationId !== organizationId) throw new ConvexError("ACCESS_DENIED");
  return project;
}
export async function checkRecruitment(
  ctx: MutationCtx,
  payload: EnrollmentPayload,
  project: Awaited<ReturnType<typeof enrollmentAccess>>,
) {
  if (!project || project.status !== "recruiting") throw new ConvexError("RECRUITMENT_CLOSED");
  const latest = await ctx.db
    .query("studyProtocols")
    .withIndex("by_project_version", (q) => q.eq("projectClientId", payload.projectClientId))
    .order("desc")
    .first();
  if (
    !latest ||
    latest.clientId !== payload.protocolClientId ||
    latest.version !== payload.protocolVersion
  )
    throw new ConvexError("PROTOCOL_OUTDATED");
  if (!latest.ethicsApproved || !latest.ethicsReference || latest.ethicsExpiresAt <= Date.now())
    throw new ConvexError("ETHICS_APPROVAL_REQUIRED");
}
