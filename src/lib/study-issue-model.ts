import { z } from "zod";

export const issueStatusSchema = z.enum(["open", "underReview", "resolved", "closed"]);
export const seriousnessSchema = z.enum([
  "death",
  "lifeThreatening",
  "hospitalization",
  "disability",
  "congenitalAnomaly",
  "medicallyImportant",
]);
export const issueDetailsSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("adverseEvent"),
    severity: z.enum(["mild", "moderate", "severe"]),
    seriousness: z
      .array(seriousnessSchema)
      .max(6)
      .refine((values) => new Set(values).size === values.length),
    causality: z.enum(["unassessed", "unrelated", "possible", "probable", "related"]),
    expectedness: z.enum(["unknown", "expected", "unexpected"]),
    suspectAgent: z.string().trim().max(500),
    actionTaken: z.string().trim().min(1).max(3000),
    outcome: z.enum(["unknown", "ongoing", "recovering", "recovered", "sequelae", "fatal"]),
    endedOn: z.union([z.literal(""), z.iso.date()]),
  }),
  z.object({
    type: z.literal("deviation"),
    impact: z.enum(["minor", "major", "critical"]),
    protocolSection: z.string().trim().min(1).max(1000),
    rootCause: z.string().trim().max(3000),
    correctiveAction: z.string().trim().max(5000),
    preventiveAction: z.string().trim().max(5000),
  }),
]);
export const studyIssuePayloadSchema = z
  .object({
    kind: z.literal("studyIssue"),
    writeId: z.uuid(),
    projectClientId: z.uuid(),
    enrollmentClientId: z.uuid(),
    protocolClientId: z.uuid(),
    protocolVersion: z.number().int().positive(),
    occurredOn: z.iso.date(),
    detectedOn: z.iso.date(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10000),
    notes: z.string().trim().max(2000),
    details: issueDetailsSchema,
    status: issueStatusSchema,
    reviewerId: z.string().min(1).max(200),
    reviewDueOn: z.iso.date(),
    resolution: z.string().trim().max(5000),
    reviewedOn: z.union([z.literal(""), z.iso.date()]),
    reviewedBy: z.string().max(200),
    amendmentReason: z.string().trim().max(2000),
  })
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (value.detectedOn < value.occurredOn || value.reviewDueOn < value.detectedOn)
      issue("detectedOn", "INVALID_CLINICAL_DATE");
    if (["resolved", "closed"].includes(value.status)) {
      if (!value.resolution || !value.reviewedOn || !value.reviewedBy)
        issue("resolution", "ISSUE_REVIEW_REQUIRED");
      if (value.reviewedOn && value.reviewedOn < value.detectedOn)
        issue("reviewedOn", "INVALID_CLINICAL_DATE");
      if (
        value.details.type === "deviation" &&
        (!value.details.rootCause ||
          !value.details.correctiveAction ||
          !value.details.preventiveAction)
      )
        issue("details", "ISSUE_CORRECTIVE_ACTION_REQUIRED");
    } else if (value.resolution || value.reviewedOn || value.reviewedBy)
      issue("resolution", "INVALID_ISSUE_REVIEW");
    if (value.details.type === "adverseEvent") {
      const terminal = ["recovered", "sequelae", "fatal"].includes(value.details.outcome);
      if (
        terminal !== Boolean(value.details.endedOn) ||
        (value.details.endedOn && value.details.endedOn < value.occurredOn)
      )
        issue("details", "INVALID_CLINICAL_DATE");
      if (value.details.outcome === "fatal" && !value.details.seriousness.includes("death"))
        issue("details", "ISSUE_SERIOUSNESS_REQUIRED");
    }
  });
export type StudyIssuePayload = z.infer<typeof studyIssuePayloadSchema>;
export const issueTransitions: Record<
  StudyIssuePayload["status"],
  readonly StudyIssuePayload["status"][]
> = {
  open: ["open", "underReview", "resolved"],
  underReview: ["underReview", "open", "resolved"],
  resolved: ["resolved", "closed"],
  closed: ["closed"],
};
export function validateStudyIssueWrite(
  previous: StudyIssuePayload | null,
  next: StudyIssuePayload,
  actorId: string,
  now: number,
) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (
    next.occurredOn > today ||
    next.detectedOn > today ||
    next.reviewedOn > today ||
    (next.details.type === "adverseEvent" && next.details.endedOn > today)
  )
    throw new Error("INVALID_CLINICAL_DATE");
  if (!previous) {
    if (next.status !== "open") throw new Error("INVALID_ISSUE_TRANSITION");
    return;
  }
  if (
    previous.projectClientId !== next.projectClientId ||
    previous.enrollmentClientId !== next.enrollmentClientId ||
    previous.protocolClientId !== next.protocolClientId ||
    previous.protocolVersion !== next.protocolVersion ||
    previous.details.type !== next.details.type
  )
    throw new Error("ISSUE_BINDING_IMMUTABLE");
  if (!issueTransitions[previous.status].includes(next.status))
    throw new Error("INVALID_ISSUE_TRANSITION");
  const reviewChanged =
    previous.status !== next.status ||
    previous.reviewerId !== next.reviewerId ||
    previous.resolution !== next.resolution ||
    previous.reviewedOn !== next.reviewedOn ||
    previous.reviewedBy !== next.reviewedBy;
  if (reviewChanged && next.status !== "open") {
    if (next.reviewerId !== actorId) throw new Error("ISSUE_REVIEWER_REQUIRED");
    if (["resolved", "closed"].includes(next.status) && next.reviewedBy !== actorId)
      throw new Error("ISSUE_REVIEWER_REQUIRED");
  }
  if (
    (["resolved", "closed"].includes(previous.status) ||
      (previous.status === "underReview" && next.status === "open")) &&
    !next.amendmentReason
  )
    throw new Error("AMENDMENT_REASON_REQUIRED");
}
export function issueOverdue(value: StudyIssuePayload, now: number) {
  return (
    ["open", "underReview"].includes(value.status) &&
    value.reviewDueOn < new Date(now).toISOString().slice(0, 10)
  );
}
