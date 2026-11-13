import { z } from "zod";

import type { EnrollmentPayload } from "@/src/lib/study-enrollment-model";
import { visitTime, visitTimeSchema } from "@/src/lib/visit-time";

export const visitFields = {
  occurredOn: z.iso.date(),
  notes: z.string().trim().max(2000),
  scheduledFor: visitTimeSchema,
  durationMinutes: z.number().int().min(1).max(1440),
  visitType: z.enum(["consultation", "procedure", "hospitalization", "followUp"]),
  status: z.enum(["planned", "inProgress", "completed", "cancelled", "noShow"]),
  reason: z.string().trim().min(1).max(1000),
  location: z.string().trim().max(200),
  outcome: z.string().trim().max(10000),
  followUpOn: z.union([z.literal(""), z.iso.date()]),
  cancellationReason: z.string().trim().max(1000),
};
export const studyVisitPayloadSchema = z
  .object({
    ...visitFields,
    kind: z.literal("studyVisit"),
    writeId: z.uuid(),
    enrollmentClientId: z.uuid(),
    enrollmentWriteId: z.uuid(),
    projectClientId: z.uuid(),
    protocolClientId: z.uuid(),
    protocolVersion: z.number().int().positive(),
    windowFrom: z.iso.date(),
    windowTo: z.iso.date(),
    performedOn: z.union([z.literal(""), z.iso.date()]),
    deviationReason: z.string().trim().max(2000),
    amendmentReason: z.string().trim().max(2000),
  })
  .superRefine((value, ctx) => {
    if (value.windowFrom > value.windowTo)
      ctx.addIssue({ code: "custom", path: ["windowTo"], message: "INVALID_VISIT_WINDOW" });
    const scheduled = visitTimeSchema.safeParse(value.scheduledFor);
    const scheduledDate = scheduled.success
      ? new Date(visitTime(scheduled.data).epoch).toISOString().slice(0, 10)
      : null;
    if (
      ((scheduledDate && (scheduledDate < value.windowFrom || scheduledDate > value.windowTo)) ||
        (value.performedOn &&
          (value.performedOn < value.windowFrom || value.performedOn > value.windowTo))) &&
      !value.deviationReason
    )
      ctx.addIssue({
        code: "custom",
        path: ["deviationReason"],
        message: "VISIT_DEVIATION_REQUIRED",
      });
    if (["planned", "noShow"].includes(value.status) && value.performedOn)
      ctx.addIssue({ code: "custom", path: ["performedOn"], message: "INVALID_VISIT_TRANSITION" });
    if (["inProgress", "completed"].includes(value.status) && !value.performedOn)
      ctx.addIssue({
        code: "custom",
        path: ["performedOn"],
        message: "VISIT_ACTUAL_DATE_REQUIRED",
      });
  });
export type StudyVisitPayload = z.infer<typeof studyVisitPayloadSchema>;
export function studyVisitNeedsAuthorization(
  previous: StudyVisitPayload | null,
  next: StudyVisitPayload,
) {
  return (
    !previous ||
    (!["completed", "cancelled", "noShow"].includes(previous.status) &&
      !["cancelled", "noShow"].includes(next.status))
  );
}
export function validateStudyVisitParticipation(
  value: StudyVisitPayload,
  enrollment: EnrollmentPayload,
  now: number,
) {
  if (
    value.projectClientId !== enrollment.projectClientId ||
    value.protocolClientId !== enrollment.protocolClientId ||
    value.protocolVersion !== enrollment.protocolVersion
  )
    throw new Error("STUDY_VISIT_BINDING_IMMUTABLE");
  if (value.enrollmentWriteId !== enrollment.writeId) throw new Error("ENROLLMENT_CHANGED");
  if (enrollment.events.at(-1)?.status !== "enrolled") throw new Error("PARTICIPATION_INACTIVE");
  const consent = enrollment.events.at(-1)!.consent!;
  const today = new Date(now).toISOString().slice(0, 10);
  // Consent, visit windows and actual dates use inclusive UTC calendar dates.
  // scheduledFor retains its IANA zone for display and DST disambiguation.
  for (const date of [
    today,
    new Date(visitTime(value.scheduledFor).epoch).toISOString().slice(0, 10),
    ...(value.performedOn ? [value.performedOn] : []),
  ])
    if (consent.signedOn > date || consent.expiresOn < date)
      throw new Error("PARTICIPATION_CONSENT_EXPIRED");
  if (value.performedOn > today) throw new Error("INVALID_CLINICAL_DATE");
}
