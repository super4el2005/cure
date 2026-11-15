import { ConvexError } from "convex/values";

import type { Id } from "@/convex/_generated/dataModel";
import type { MutationCtx } from "@/convex/_generated/server";
import { projectAccess } from "@/convex/lib/research";
import { scheduledVisits } from "@/src/lib/protocol-schedule";
import type { VisitScheduleItem } from "@/src/lib/protocol-schedule";
import type { EnrollmentPayload } from "@/src/lib/study-enrollment-model";
import type { StudyVisitPayload } from "@/src/lib/study-visit-model";

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
  return latest;
}

// Enrollment of a participant generates the planned visits of the current
// protocol schedule. Visits beyond the documented consent validity are not
// created: they must be scheduled after the clinic renews the consent.
export async function scheduleStudyVisits(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    recordClientId: string;
    patientClientId: string;
    payload: EnrollmentPayload;
    protocol: { visitSchedule?: VisitScheduleItem[] };
    actorId: string;
  },
) {
  const event = args.payload.events.at(-1)!;
  if (event.status !== "enrolled" || !event.consent) return;
  const now = Date.now();
  for (const visit of scheduledVisits(
    args.protocol.visitSchedule ?? [],
    event.occurredOn,
    event.consent,
  )) {
    const clientId = crypto.randomUUID();
    const historyId = crypto.randomUUID();
    const visitPayload: StudyVisitPayload = {
      kind: "studyVisit",
      writeId: crypto.randomUUID(),
      occurredOn: event.occurredOn,
      notes: "",
      enrollmentClientId: args.recordClientId,
      enrollmentWriteId: args.payload.writeId,
      projectClientId: args.payload.projectClientId,
      protocolClientId: args.payload.protocolClientId,
      protocolVersion: args.payload.protocolVersion,
      windowFrom: visit.windowFrom,
      windowTo: visit.windowTo,
      performedOn: "",
      deviationReason: "",
      amendmentReason: "",
      scheduledFor: visit.scheduledFor,
      durationMinutes: visit.item.durationMinutes,
      visitType: visit.item.visitType,
      status: "planned",
      reason: visit.item.title,
      location: "",
      outcome: "",
      followUpOn: "",
      cancellationReason: "",
    };
    await ctx.db.insert("clinicalRecords", {
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
      clientId,
      historyId,
      payload: visitPayload,
      revision: 1,
      deleted: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: args.actorId,
    });
    await ctx.db.insert("clinicalVersions", {
      organizationId: args.organizationId,
      clientId: historyId,
      recordClientId: clientId,
      patientClientId: args.patientClientId,
      revision: 1,
      payload: visitPayload,
      recordedAt: now,
      recordedBy: args.actorId,
    });
    await ctx.db.insert("clinicalAudit", {
      organizationId: args.organizationId,
      patientClientId: args.patientClientId,
      recordClientId: clientId,
      actorId: args.actorId,
      action: "create",
      revision: 1,
      at: now,
    });
  }
}
