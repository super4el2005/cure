import { describe, expect, it } from "@rstest/core";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import {
  cohortLongitudinal,
  cohortLongitudinalSchema,
  defaultCohortLongitudinal,
  longitudinalBucket,
} from "@/src/lib/cohort-longitudinal";
import { statisticsSourceSignature } from "@/src/lib/cohort-statistics";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";

const criteria = { ...defaultCohortCriteria, include: ["A"] };
const settings = { ...defaultCohortLongitudinal, code: "HbA1c" };
function patient(group: string, extra: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private name",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: [group],
    notes: "Private notes",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...extra,
  });
}
function observation(
  patientClientId: string,
  code: string,
  numericValue: number | null,
  occurredOn: string,
  extra: Partial<ClinicalRecord> = {},
): ClinicalRecord {
  return clinicalRecordSchema.parse({
    clientId: crypto.randomUUID(),
    patientClientId,
    revision: 1,
    deleted: false,
    payload: {
      kind: "observation",
      occurredOn,
      notes: "Private note",
      name: "Glycated hemoglobin",
      code,
      numericValue,
      textValue: numericValue === null ? "unreadable" : "",
      unit: "%",
    },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
}
function fixture() {
  const members = [patient("A"), patient("A")];
  const outsider = patient("B");
  const records = [
    observation(members[0]!.clientId, "HbA1c", 6.0, "2025-01-05"),
    observation(members[0]!.clientId, "HbA1c", 7.0, "2025-01-20"),
    observation(members[0]!.clientId, "HbA1c", 8.0, "2025-03-10"),
    observation(members[1]!.clientId, "HbA1c", 10.0, "2025-03-15"),
    observation(members[1]!.clientId, "HbA1c", null, "2025-03-16"),
    observation(members[1]!.clientId, "LDL", 3.0, "2025-03-15"),
    {
      ...observation(members[1]!.clientId, "HbA1c", 99, "2025-03-17"),
      deleted: true,
      payload: null,
    },
    observation(outsider.clientId, "HbA1c", 12.0, "2025-03-20"),
  ];
  return { members, outsider, records };
}

describe("longitudinal buckets", () => {
  it("maps dates to calendar months and quarters", () => {
    expect(longitudinalBucket("2025-03-10", "month")).toBe("2025-03");
    expect(longitudinalBucket("2025-01-10", "quarter")).toBe("2025-Q1");
    expect(longitudinalBucket("2025-03-10", "quarter")).toBe("2025-Q1");
    expect(longitudinalBucket("2025-04-10", "quarter")).toBe("2025-Q2");
    expect(longitudinalBucket("2025-12-31", "quarter")).toBe("2025-Q4");
  });
});
describe("cohort longitudinal dynamics", () => {
  it("aggregates every numeric value into its sorted calendar period", () => {
    const { members, records } = fixture();
    const result = cohortLongitudinal(members, "doctor", criteria, records, settings, 50);
    expect(result.members).toBe(2);
    expect(result.patients).toBe(2);
    expect(result.observations).toBe(4);
    expect(result.series.map((period) => period.key)).toEqual(["2025-01", "2025-03"]);
    expect(result.series[0]).toMatchObject({ n: 2, patients: 1, min: 6, max: 7 });
    expect(result.series[0]!.mean).toBeCloseTo(6.5, 12);
    expect(result.series[0]!.median).toBeCloseTo(6.5, 12);
    expect(result.series[1]).toMatchObject({ n: 2, patients: 2, min: 8, max: 10 });
    expect(result.series[1]!.mean).toBeCloseTo(9, 12);
    expect(result.signature).toBe(
      statisticsSourceSignature(members, "doctor", criteria, records, 50),
    );
    expect(JSON.stringify(result)).not.toMatch(/Private|Glycated|clientId/);
    expect(JSON.stringify(result)).not.toContain(members[0]!.clientId);
  });
  it("groups the same data into calendar quarters", () => {
    const { members, records } = fixture();
    const result = cohortLongitudinal(
      members,
      "doctor",
      criteria,
      records,
      { ...settings, bucket: "quarter" },
      50,
    );
    expect(result.series.map((period) => period.key)).toEqual(["2025-Q1"]);
    expect(result.series[0]).toMatchObject({ n: 4, patients: 2 });
    expect(result.series[0]!.median).toBeCloseTo(7.5, 12);
  });
  it("reports an empty series when the code has no numeric values", () => {
    const { members, records } = fixture();
    const result = cohortLongitudinal(
      members,
      "doctor",
      criteria,
      records,
      { ...settings, code: "CRP" },
      50,
    );
    expect(result.series).toEqual([]);
    expect(result.observations).toBe(0);
    expect(result.patients).toBe(0);
  });
  it("rejects an invalid definition", () => {
    expect(cohortLongitudinalSchema.safeParse({ ...settings, code: "" }).success).toBe(false);
    expect(
      cohortLongitudinalSchema.safeParse({ ...settings, bucket: "week" as never }).success,
    ).toBe(false);
    expect(() => longitudinalBucket("2025-13-01", "quarter")).toThrow(
      "ANALYSIS_CALCULATION_FAILED",
    );
  });
});
