import { z } from "zod";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import { visitTime } from "@/src/lib/visit-time";

export const timelineKinds = [
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
export const timelineFiltersSchema = z
  .object({
    from: z.union([z.literal(""), z.iso.date()]),
    to: z.union([z.literal(""), z.iso.date()]),
    kinds: z.array(z.enum(timelineKinds)),
    phase: z.enum(["all", "recorded", "schedule", "unconfirmed"]),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    path: ["to"],
    message: "INVALID_TIMELINE_RANGE",
  });
export const defaultTimelineFilters: z.infer<typeof timelineFiltersSchema> = {
  from: "",
  to: "",
  kinds: [],
  phase: "all",
};
export type TimelineEventType =
  | "entry"
  | "medicationStart"
  | "medicationEnd"
  | "medicationEndUnconfirmed"
  | "visitSchedule"
  | "visitPerformed"
  | "followUp"
  | "enrollment"
  | "issueOnset"
  | "issueDetected"
  | "issueReviewDue"
  | "issueReview"
  | "issueEnd";
export type PatientTimelineEvent = {
  key: string;
  date: string;
  phase: "recorded" | "schedule" | "unconfirmed";
  type: TimelineEventType;
  source: ClinicalRecord;
  detail: string;
  author: string | null;
  recordedAt: number | null;
  scheduledFor?: string;
  enrollmentStatus?: EnrollmentStatus;
};
// This is a date-based projection of current authorized records, not a second
// stored timeline, historical snapshots, or inferred clinical occurrences.
export function patientTimeline(
  records: readonly ClinicalRecord[],
  access: { patientId: string; role: string; expiresAt: number; now: number },
  input: unknown = defaultTimelineFilters,
): PatientTimelineEvent[] {
  if (
    access.role !== "doctor" ||
    !Number.isFinite(access.now) ||
    !Number.isFinite(access.expiresAt) ||
    access.now >= access.expiresAt
  )
    return [];
  const filters = timelineFiltersSchema.parse(input);
  const events: PatientTimelineEvent[] = [];
  const seen = new Set<string>();
  for (const source of records) {
    if (source.deleted || !source.payload || source.patientClientId !== access.patientId) continue;
    if (seen.has(source.clientId)) throw new Error("INVALID_TIMELINE_DATA");
    seen.add(source.clientId);
    const value = source.payload;
    if (filters.kinds.length && !filters.kinds.includes(value.kind)) continue;
    const add = (
      type: TimelineEventType,
      date: string,
      phase: PatientTimelineEvent["phase"],
      detail = "",
      suffix: string = type,
      meta: Partial<
        Pick<PatientTimelineEvent, "author" | "recordedAt" | "scheduledFor" | "enrollmentStatus">
      > = {},
    ) => {
      if (
        (filters.from && date < filters.from) ||
        (filters.to && date > filters.to) ||
        (filters.phase !== "all" && filters.phase !== phase)
      )
        return;
      events.push({
        key: `${source.clientId}:${suffix}`,
        date,
        phase,
        type,
        source,
        detail,
        author: null,
        recordedAt: null,
        ...meta,
      });
    };
    if (value.kind === "medication") {
      add("medicationStart", value.occurredOn, "recorded", value.drug);
      if (value.endedOn)
        add(
          value.status === "active" ? "medicationEndUnconfirmed" : "medicationEnd",
          value.endedOn,
          value.status === "active" ? "unconfirmed" : "recorded",
          value.drug,
        );
    } else if (value.kind === "visit" || value.kind === "studyVisit") {
      const scheduled = visitTime(value.scheduledFor);
      add("visitSchedule", scheduled.date, "schedule", value.reason, "visitSchedule", {
        scheduledFor: value.scheduledFor,
      });
      if (value.kind === "studyVisit" && value.performedOn)
        add("visitPerformed", value.performedOn, "recorded", value.outcome);
      if (value.followUpOn) add("followUp", value.followUpOn, "schedule");
    } else if (value.kind === "enrollment") {
      for (const event of value.events)
        add("enrollment", event.occurredOn, "recorded", event.reason, event.id, {
          author: event.recordedBy,
          recordedAt: event.recordedAt,
          enrollmentStatus: event.status,
        });
    } else if (value.kind === "studyIssue") {
      add("issueOnset", value.occurredOn, "recorded", value.title);
      add("issueDetected", value.detectedOn, "recorded", value.title);
      add("issueReviewDue", value.reviewDueOn, "schedule", value.title);
      if (value.reviewedOn)
        add("issueReview", value.reviewedOn, "recorded", value.resolution, "issueReview", {
          author: value.reviewedBy,
        });
      if (value.details.type === "adverseEvent" && value.details.endedOn)
        add("issueEnd", value.details.endedOn, "recorded", value.title);
    } else
      add(
        "entry",
        value.occurredOn,
        "recorded",
        value.kind === "allergy"
          ? value.substance
          : value.kind === "observation"
            ? value.name
            : value.kind === "questionnaire"
              ? value.definition.title
              : value.text.slice(0, 200),
      );
  }
  return events.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}
