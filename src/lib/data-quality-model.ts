import { z } from "zod";

export const qualitySourceKinds = [
  "history",
  "allergy",
  "medication",
  "observation",
  "visit",
  "questionnaire",
  "enrollment",
  "studyVisit",
  "studyIssue",
] as const;
export const qualityCodes = [
  "fullNameMissing",
  "birthDateMissing",
  "sexMissing",
  "diagnosesUndocumented",
  "historyUndocumented",
  "allergiesUndocumented",
  "medicationsUndocumented",
  "observationsUndocumented",
  "dateBeforeBirth",
  "medicationEndUnconfirmed",
  "medicationEndMissing",
  "visitNeedsStatusUpdate",
  "studyWindowPassed",
  "safetyReviewPastDue",
  "questionnaireNeedsCompletion",
  "possibleDuplicate",
] as const;
export const qualityCodeSchema = z.enum(qualityCodes);
export const qualityReviewPayloadSchema = z.object({
  kind: z.literal("qualityReview"),
  writeId: z.uuid(),
  occurredOn: z.iso.date(),
  notes: z.string().trim().min(1).max(2000),
  algorithmVersion: z.literal("patient-quality-v1"),
  evaluationDate: z.iso.date(),
  sourceSignature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  findingKey: z.string().min(1).max(120),
  code: qualityCodeSchema,
  decision: z.enum(["needsClarification", "reviewedAsRecorded"]),
  reviewedBy: z.string().min(1).max(200),
});
export type QualityReviewPayload = z.infer<typeof qualityReviewPayloadSchema>;
