import { describe, expect, it } from "@rstest/core";

import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import {
  defaultTimelineFilters,
  patientTimeline,
  timelineFiltersSchema,
} from "@/src/lib/patient-timeline";

const patientId = crypto.randomUUID();
const access = { patientId, role: "doctor", expiresAt: 200, now: 100 };
function record(payload: ClinicalPayload) {
  return clinicalRecordSchema.parse({
    clientId: crypto.randomUUID(),
    patientClientId: patientId,
    revision: 1,
    deleted: false,
    payload,
    createdAt: 1,
    updatedAt: 2,
    updatedBy: "doctor",
  });
}
const history = () =>
  record({ kind: "history", occurredOn: "2020-01-01", notes: "", text: "Private history" });
const visit = () => ({
  kind: "visit" as const,
  occurredOn: "2026-11-01",
  scheduledFor: "2026-11-01T01:30:00-04:00[America/New_York]",
  durationMinutes: 30,
  visitType: "consultation" as const,
  status: "completed" as const,
  reason: "Private reason",
  location: "",
  outcome: "Recorded outcome",
  followUpOn: "",
  cancellationReason: "",
  notes: "",
});
describe("authorized date-based patient timeline", () => {
  it("denies researcher, administrator and expired or invalid leases before reading contents", () => {
    const source = [history()];
    for (const role of ["researcher", "admin", ""])
      expect(patientTimeline(source, { ...access, role }, null)).toEqual([]);
    expect(patientTimeline(source, { ...access, now: 200 })).toEqual([]);
    expect(patientTimeline(source, { ...access, expiresAt: NaN })).toEqual([]);
  });
  it("excludes deleted and other-patient records without mutating clinical data", () => {
    const row = history();
    const before = JSON.stringify(row);
    expect(
      patientTimeline(
        [
          row,
          { ...row, clientId: crypto.randomUUID(), patientClientId: crypto.randomUUID() },
          { ...row, clientId: crypto.randomUUID(), deleted: true, payload: null },
        ],
        access,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(row)).toBe(before);
  });
  it("keeps a completed ordinary visit's scheduled time separate from an unknown actual date", () => {
    const result = patientTimeline([record(visit())], access);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "visitSchedule",
      phase: "schedule",
      date: "2026-11-01",
      scheduledFor: visit().scheduledFor,
      recordedAt: null,
      author: null,
    });
    expect(result.some((event) => event.type === "visitPerformed")).toBe(false);
  });
  it("uses the source zone calendar day instead of changing the visit date to UTC", () => {
    const payload = {
      ...visit(),
      occurredOn: "2026-11-02",
      scheduledFor: "2026-11-02T00:30:00+14:00[Pacific/Kiritimati]",
    };
    expect(patientTimeline([record(payload)], access)[0]?.date).toBe("2026-11-02");
  });
  it("separates actual study visits and recommended follow-up from schedule dates", () => {
    const payload = {
      ...visit(),
      kind: "studyVisit" as const,
      writeId: crypto.randomUUID(),
      enrollmentClientId: crypto.randomUUID(),
      enrollmentWriteId: crypto.randomUUID(),
      projectClientId: crypto.randomUUID(),
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      windowFrom: "2026-10-01",
      windowTo: "2026-12-01",
      performedOn: "2026-11-02",
      followUpOn: "2026-11-03",
      deviationReason: "",
      amendmentReason: "",
    };
    const result = patientTimeline([record(payload)], access);
    expect(result.map((event) => [event.type, event.phase, event.date])).toEqual([
      ["followUp", "schedule", "2026-11-03"],
      ["visitPerformed", "recorded", "2026-11-02"],
      ["visitSchedule", "schedule", "2026-11-01"],
    ]);
  });
  it("does not invent completed therapy from an end date while the therapy remains active", () => {
    const payload = {
      kind: "medication" as const,
      occurredOn: "2020-01-01",
      notes: "",
      drug: "Recorded drug",
      code: "",
      dosage: "Recorded dosage",
      route: "",
      endedOn: "2020-01-02",
      status: "active" as const,
    };
    const result = patientTimeline([record(payload)], access);
    expect(result[0]).toMatchObject({ type: "medicationEndUnconfirmed", phase: "unconfirmed" });
    expect(patientTimeline([record({ ...payload, status: "stopped" })], access)[0]).toMatchObject({
      type: "medicationEnd",
      phase: "recorded",
    });
  });
  it("keeps individual enrollment event authors, timestamps and stable IDs", () => {
    const first = {
      id: crypto.randomUUID(),
      status: "screening" as const,
      occurredOn: "2020-01-01",
      reason: "Screening",
      recordedBy: "original-doctor",
      recordedAt: 1,
      eligibilityEvidence: "",
      inclusionConfirmed: false,
      exclusionAbsent: false,
      consent: null,
    };
    const second = {
      ...first,
      id: crypto.randomUUID(),
      status: "declined" as const,
      occurredOn: "2020-01-02",
      reason: "Declined",
      recordedAt: 2,
    };
    const source = record({
      kind: "enrollment",
      writeId: crypto.randomUUID(),
      occurredOn: first.occurredOn,
      notes: "",
      projectClientId: crypto.randomUUID(),
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      events: [first, second],
    });
    const result = patientTimeline([source], access);
    expect(result[0]).toMatchObject({
      type: "enrollment",
      author: first.recordedBy,
      recordedAt: 2,
      enrollmentStatus: "declined",
      key: `${source.clientId}:${second.id}`,
    });
    expect(result[1]?.recordedAt).toBe(1);
  });
  it("distinguishes safety onset, detection, due date, review and recorded outcome", () => {
    const source = record({
      kind: "studyIssue",
      writeId: crypto.randomUUID(),
      projectClientId: crypto.randomUUID(),
      enrollmentClientId: crypto.randomUUID(),
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      occurredOn: "2020-01-01",
      detectedOn: "2020-01-02",
      title: "Private safety issue",
      description: "Recorded description",
      notes: "",
      status: "resolved",
      reviewerId: "doctor",
      reviewDueOn: "2020-01-06",
      resolution: "Reviewed",
      reviewedOn: "2020-01-03",
      reviewedBy: "reviewing-doctor",
      amendmentReason: "",
      details: {
        type: "adverseEvent",
        severity: "mild",
        seriousness: [],
        causality: "unassessed",
        expectedness: "unknown",
        suspectAgent: "",
        actionTaken: "Recorded response",
        outcome: "recovered",
        endedOn: "2020-01-04",
      },
    });
    const result = patientTimeline([source], access);
    expect(result.map((event) => event.type)).toEqual([
      "issueReviewDue",
      "issueEnd",
      "issueReview",
      "issueDetected",
      "issueOnset",
    ]);
    expect(result.find((event) => event.type === "issueReview")?.author).toBe("reviewing-doctor");
    expect(result.filter((event) => event.phase === "schedule")).toHaveLength(1);
  });
  it("filters inclusively by calendar date, category and date meaning", () => {
    const sources = [history(), record(visit())];
    expect(
      patientTimeline(sources, access, {
        ...defaultTimelineFilters,
        from: "2020-01-01",
        to: "2020-01-01",
      }),
    ).toHaveLength(1);
    expect(
      patientTimeline(sources, access, {
        ...defaultTimelineFilters,
        phase: "schedule",
        kinds: ["visit"],
      }),
    ).toHaveLength(1);
    expect(
      timelineFiltersSchema.safeParse({
        ...defaultTimelineFilters,
        from: "2020-01-02",
        to: "2020-01-01",
      }).success,
    ).toBe(false);
    expect(
      timelineFiltersSchema.safeParse({ ...defaultTimelineFilters, from: "2020-02-30" }).success,
    ).toBe(false);
  });
  it("is deterministic within a day and rejects duplicate current record identities", () => {
    const a = history(),
      b = history();
    expect(patientTimeline([a, b], access).map((event) => event.key)).toEqual(
      patientTimeline([b, a], access).map((event) => event.key),
    );
    expect(() => patientTimeline([a, a], access)).toThrow("INVALID_TIMELINE_DATA");
  });
});
