import { describe, expect, it } from "@rstest/core";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import {
  availableObservationCodes,
  cohortMemberIds,
  cohortStatistics,
  cohortStatisticsSchema,
  defaultCohortStatistics,
  descriptiveStatistics,
  observationValues,
  pearsonCorrelation,
  statisticsSourceSignature,
} from "@/src/lib/cohort-statistics";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";

const criteria = { ...defaultCohortCriteria, include: ["A"] };
const settings = { ...defaultCohortStatistics, primary: "HbA1c" };
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

describe("descriptive statistics", () => {
  it("computes type-7 quartiles, mean and sample deviation on a known sample", () => {
    const stats = descriptiveStatistics([4, 1, 3, 2])!;
    expect(stats.n).toBe(4);
    expect(stats.mean).toBeCloseTo(2.5, 12);
    expect(stats.sd).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(stats.min).toBe(1);
    expect(stats.q1).toBeCloseTo(1.75, 12);
    expect(stats.median).toBeCloseTo(2.5, 12);
    expect(stats.q3).toBeCloseTo(3.25, 12);
    expect(stats.max).toBe(4);
    expect(descriptiveStatistics([])).toBe(null);
    expect(descriptiveStatistics([7])!).toMatchObject({ n: 1, sd: null, q1: 7, q3: 7 });
  });
  it("rejects non-finite values", () => {
    expect(() => descriptiveStatistics([1, Number.NaN])).toThrow("ANALYSIS_CALCULATION_FAILED");
    expect(() => pearsonCorrelation([[1, Number.POSITIVE_INFINITY]])).toThrow(
      "ANALYSIS_CALCULATION_FAILED",
    );
  });
});
describe("pearson correlation", () => {
  it("matches known values and guards degenerate samples", () => {
    expect(
      pearsonCorrelation([
        [1, 2],
        [2, 4],
        [3, 6],
      ]),
    ).toEqual({ reason: null, n: 3, r: 1 });
    expect(
      pearsonCorrelation([
        [1, 6],
        [2, 4],
        [3, 2],
      ]).r,
    ).toBeCloseTo(-1, 12);
    // Reference dataset with an exact known interior value: r = -0.5.
    expect(
      pearsonCorrelation([
        [0, 0],
        [1, 0],
        [0, 1],
      ]).r,
    ).toBeCloseTo(-0.5, 12);
    // Symmetric pattern with an exact zero correlation.
    expect(
      pearsonCorrelation([
        [0, 0],
        [1, 1],
        [2, 0],
      ]).r,
    ).toBeCloseTo(0, 12);
    expect(
      pearsonCorrelation([
        [1, 1],
        [2, 2],
      ]),
    ).toEqual({ reason: "small", n: 2, r: null });
    expect(
      pearsonCorrelation([
        [1, 1],
        [1, 2],
        [1, 3],
      ]),
    ).toEqual({ reason: "constant", n: 3, r: null });
  });
});
describe("cohort observation statistics", () => {
  function fixture() {
    const members = [patient("A"), patient("A"), patient("A")];
    const outsider = patient("B");
    const records = [
      observation(members[0]!.clientId, "HbA1c", 6.1, "2025-01-10"),
      observation(members[0]!.clientId, "HbA1c", 7.4, "2025-03-10"),
      {
        ...observation(members[0]!.clientId, "HbA1c", 99, "2025-04-10"),
        deleted: true,
        payload: null,
      },
      observation(members[0]!.clientId, "HbA1c", null, "2025-05-10"),
      observation(members[1]!.clientId, "HbA1c", 8.2, "2025-02-10"),
      observation(members[2]!.clientId, "LDL", 3.1, "2025-02-10"),
      observation(outsider.clientId, "HbA1c", 11.5, "2025-02-10"),
    ];
    return { members, outsider, records };
  }
  it("keeps only the latest numeric value per patient and per exact code", () => {
    const { members, records } = fixture();
    const memberIds = new Set(members.map((row) => row.clientId));
    const values = observationValues(records, memberIds, "HbA1c");
    expect(values.size).toBe(2);
    expect(values.get(members[0]!.clientId)).toBe(7.4);
    expect(values.get(members[1]!.clientId)).toBe(8.2);
    expect(availableObservationCodes(records, memberIds)).toEqual(["HbA1c", "LDL"]);
  });
  it("prefers the newer update on equal dates and skips deleted rows", () => {
    const member = patient("A");
    const older = observation(member.clientId, "HbA1c", 6.0, "2025-01-10", { updatedAt: 5 });
    const newer = observation(member.clientId, "HbA1c", 6.5, "2025-01-10", { updatedAt: 9 });
    const values = observationValues([older, newer], new Set([member.clientId]), "HbA1c");
    expect(values.get(member.clientId)).toBe(6.5);
  });
  it("aggregates the cohort without leaking identifiers or private text", () => {
    const { members, records } = fixture();
    const patients = [...members, patient("B")];
    const result = cohortStatistics(patients, "doctor", criteria, records, settings, 50);
    expect(result.members).toBe(3);
    expect(result.withPrimary).toBe(2);
    expect(result.primary).toMatchObject({ n: 2, min: 7.4, max: 8.2 });
    expect(result.primary!.mean).toBeCloseTo(7.8, 12);
    expect(result.secondary).toBe(null);
    expect(result.correlation).toBe(null);
    expect(result.signature).toBe(
      statisticsSourceSignature(patients, "doctor", criteria, records, 50),
    );
    expect(JSON.stringify(result)).not.toMatch(/Private|Glycated|clientId/);
    expect(JSON.stringify(result)).not.toContain(members[0]!.clientId);
  });
  it("correlates paired latest values and reports guards", () => {
    const { members, records } = fixture();
    const patients = [...members];
    const enriched = [
      ...records,
      observation(members[0]!.clientId, "LDL", 2.0, "2025-02-10"),
      observation(members[1]!.clientId, "LDL", 4.0, "2025-02-10"),
    ];
    const paired = cohortStatistics(
      patients,
      "doctor",
      criteria,
      enriched,
      { ...settings, secondary: "LDL" },
      50,
    );
    expect(paired.secondary).toMatchObject({ n: 3 });
    expect(paired.correlation).toEqual({ reason: "small", n: 2, r: null });
    const same = cohortStatistics(
      patients,
      "doctor",
      criteria,
      enriched,
      { ...settings, secondary: "HbA1c" },
      50,
    );
    expect(same.correlation).toEqual({ reason: "same", n: 0, r: null });
  });
  it("rejects an invalid definition", () => {
    expect(cohortStatisticsSchema.safeParse({ ...settings, primary: "" }).success).toBe(false);
    expect(
      cohortStatisticsSchema.safeParse({ ...settings, secondary: "x".repeat(101) }).success,
    ).toBe(false);
  });
  it("signature reacts to membership and observation changes only", () => {
    const { members, records } = fixture();
    const patients = [...members];
    const before = statisticsSourceSignature(patients, "doctor", criteria, records, 50);
    expect(
      statisticsSourceSignature(patients, "doctor", criteria, [...records].reverse(), 50),
    ).toBe(before);
    const revised = records.map((record, index) =>
      index === 0 ? { ...record, revision: 2 } : record,
    );
    expect(statisticsSourceSignature(patients, "doctor", criteria, revised, 50)).not.toBe(before);
    const grown = [...patients, patient("A")];
    expect(statisticsSourceSignature(grown, "doctor", criteria, records, 50)).not.toBe(before);
    expect(cohortMemberIds(patients, "researcher", criteria, 50).size).toBe(3);
    expect(cohortMemberIds(patients, "researcher", criteria, 150).size).toBe(0);
  });
});
