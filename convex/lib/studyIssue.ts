import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import type { MutationCtx } from "@/convex/_generated/server";
import type { StudyIssuePayload } from "@/src/lib/study-issue-model";

export async function checkStudyIssue(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  patientClientId: string,
  previous: StudyIssuePayload | null,
  next: StudyIssuePayload,
) {
  if (!previous) {
    const enrollment = await ctx.db
      .query("clinicalRecords")
      .withIndex("by_client", (q) =>
        q.eq("organizationId", organizationId).eq("clientId", next.enrollmentClientId),
      )
      .unique();
    if (
      !enrollment ||
      enrollment.deleted ||
      enrollment.patientClientId !== patientClientId ||
      enrollment.payload?.kind !== "enrollment"
    )
      throw new ConvexError("PARTICIPATION_INACTIVE");
    if (
      enrollment.payload.projectClientId !== next.projectClientId ||
      enrollment.payload.protocolClientId !== next.protocolClientId ||
      enrollment.payload.protocolVersion !== next.protocolVersion
    )
      throw new ConvexError("ISSUE_BINDING_IMMUTABLE");
  }
  if (!previous || previous.reviewerId !== next.reviewerId) {
    const reviewer = await ctx.db
      .query("memberships")
      .withIndex("by_organization_user", (q) =>
        q.eq("organizationId", organizationId).eq("userId", next.reviewerId),
      )
      .unique();
    if (!reviewer?.active || !reviewer.verified || reviewer.role !== "doctor")
      throw new ConvexError("ISSUE_REVIEWER_UNAVAILABLE");
  }
}
