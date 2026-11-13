import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import type { MutationCtx } from "@/convex/_generated/server";
import { projectAccess } from "@/convex/lib/research";
import { validateStudyVisitParticipation } from "@/src/lib/study-visit-model";
import type { StudyVisitPayload } from "@/src/lib/study-visit-model";
import { visitTime } from "@/src/lib/visit-time";

export async function studyVisitAccess(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  value: StudyVisitPayload,
) {
  const access = await projectAccess(ctx, value.projectClientId, "contribute");
  if (access.member.organizationId !== organizationId) throw new ConvexError("ACCESS_DENIED");
  return access.project;
}
export async function checkStudyVisit(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  patientClientId: string,
  value: StudyVisitPayload,
  project: Awaited<ReturnType<typeof studyVisitAccess>>,
) {
  if (!["recruiting", "active"].includes(project.status))
    throw new ConvexError("RECRUITMENT_CLOSED");
  const record = await ctx.db
    .query("clinicalRecords")
    .withIndex("by_client", (q) =>
      q.eq("organizationId", organizationId).eq("clientId", value.enrollmentClientId),
    )
    .unique();
  if (
    !record ||
    record.deleted ||
    record.patientClientId !== patientClientId ||
    record.payload?.kind !== "enrollment"
  )
    throw new ConvexError("PARTICIPATION_INACTIVE");
  try {
    validateStudyVisitParticipation(value, record.payload, Date.now());
  } catch (error) {
    throw new ConvexError(error instanceof Error ? error.message : "INVALID_CLINICAL_RECORD");
  }
  const latest = await ctx.db
    .query("studyProtocols")
    .withIndex("by_project_version", (q) => q.eq("projectClientId", value.projectClientId))
    .order("desc")
    .first();
  if (
    !latest ||
    latest.clientId !== value.protocolClientId ||
    latest.version !== value.protocolVersion
  )
    throw new ConvexError("PROTOCOL_OUTDATED");
  const end = visitTime(value.scheduledFor).epoch + value.durationMinutes * 60000;
  if (
    !latest.ethicsApproved ||
    !latest.ethicsReference ||
    latest.ethicsExpiresAt <= Date.now() ||
    latest.ethicsExpiresAt < end
  )
    throw new ConvexError("ETHICS_APPROVAL_REQUIRED");
}
