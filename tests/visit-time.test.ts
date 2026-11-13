import { describe, expect, it } from "@rstest/core";

import { clinicalPayloadSchema, validateClinicalTransition } from "@/src/lib/clinical-record-model";
import { resolveVisitTime, visitTime, visitTimeSchema } from "@/src/lib/visit-time";

const sampleVisit = {
  kind: "visit" as const,
  occurredOn: "2026-11-01",
  notes: "Private visit note",
  scheduledFor: "2026-11-01T01:30:00-04:00[America/New_York]",
  durationMinutes: 30,
  visitType: "consultation" as const,
  status: "planned" as const,
  reason: "Private visit reason",
  location: "Private location",
  outcome: "",
  followUpOn: "",
  cancellationReason: "",
};
describe("exact visit schedule", () => {
  it("requires an explicit choice for a repeated hour and preserves both possible instants", () => {
    expect(() => resolveVisitTime("2026-11-01 01:30:00", "America/New_York")).toThrow(
      "AMBIGUOUS_VISIT_TIME",
    );
    const early = resolveVisitTime("2026-11-01 01:30:00", "America/New_York", "earlier");
    const late = resolveVisitTime("2026-11-01 01:30:00", "America/New_York", "later");
    expect(visitTime(late).epoch - visitTime(early).epoch).toBe(3600000);
    expect(visitTime(early).local).toBe(visitTime(late).local);
    expect(visitTimeSchema.parse(early)).toBe(sampleVisit.scheduledFor);
    expect(visitTimeSchema.safeParse("2026-11-01T01:30:00[America/New_York]").success).toBe(false);
  });
  it("rejects nonexistent hours and skipped days instead of shifting the appointment", () => {
    for (const disambiguation of ["reject", "earlier", "later"] as const) {
      expect(() =>
        resolveVisitTime("2026-03-08 02:30:00", "America/New_York", disambiguation),
      ).toThrow("NONEXISTENT_VISIT_TIME");
      expect(() => resolveVisitTime("2011-12-30 12:00:00", "Pacific/Apia", disambiguation)).toThrow(
        "NONEXISTENT_VISIT_TIME",
      );
    }
    expect(visitTimeSchema.safeParse("2026-03-08T02:30:00-05:00[America/New_York]").success).toBe(
      false,
    );
  });
  it("supports quarter-hour offsets, strict calendar validation and independent zone dates", () => {
    const zoned = resolveVisitTime("2026-01-01 00:15:00", "Asia/Kathmandu");
    expect(zoned).toBe("2026-01-01T00:15:00+05:45[Asia/Kathmandu]");
    expect(new Date(visitTime(zoned).epoch).toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(visitTime(zoned).date).toBe("2026-01-01");
    expect(() => resolveVisitTime("2026-02-31 12:00:00", "UTC")).toThrow("INVALID_VISIT_TIME");
    expect(() => resolveVisitTime("2026-01-01 12:00:00", "Invalid/Zone")).toThrow(
      "INVALID_VISIT_TIME",
    );
  });
});
describe("clinical visit invariants", () => {
  it("requires the local date, completed outcome, cancellation reason and valid follow-up date", () => {
    expect(clinicalPayloadSchema.safeParse(sampleVisit).success).toBe(true);
    for (const changes of [
      { occurredOn: "2026-10-31" },
      { durationMinutes: 0 },
      { durationMinutes: 1.5 },
      { status: "completed" },
      { status: "cancelled" },
      { followUpOn: "2026-10-31" },
    ])
      expect(clinicalPayloadSchema.safeParse({ ...sampleVisit, ...changes }).success).toBe(false);
    expect(
      clinicalPayloadSchema.safeParse({
        ...sampleVisit,
        status: "completed",
        outcome: "Recorded outcome",
        followUpOn: "2026-11-02",
      }).success,
    ).toBe(true);
  });
  it("allows corrections but prevents terminal visits from being reopened or silently rescheduled", () => {
    const completed = clinicalPayloadSchema.parse({
      ...sampleVisit,
      status: "completed",
      outcome: "Recorded outcome",
    });
    if (completed.kind !== "visit") throw new Error("Expected visit fixture");
    expect(() => validateClinicalTransition(sampleVisit, completed)).not.toThrow();
    expect(() =>
      validateClinicalTransition(completed, { ...completed, notes: "Corrected note" }),
    ).not.toThrow();
    expect(() => validateClinicalTransition(completed, sampleVisit)).toThrow(
      "INVALID_VISIT_TRANSITION",
    );
    expect(() =>
      validateClinicalTransition(completed, { ...completed, durationMinutes: 60 }),
    ).toThrow("VISIT_SCHEDULE_IMMUTABLE");
    const cancelled = clinicalPayloadSchema.parse({
      ...sampleVisit,
      status: "cancelled",
      cancellationReason: "Recorded reason",
    });
    expect(() => validateClinicalTransition(cancelled, sampleVisit)).toThrow(
      "INVALID_VISIT_TRANSITION",
    );
    expect(() =>
      validateClinicalTransition(
        { ...sampleVisit, status: "inProgress" },
        { ...sampleVisit, status: "noShow" },
      ),
    ).toThrow("INVALID_VISIT_TRANSITION");
  });
});
