import { describe, expect, it } from "@rstest/core";

import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import {
  compareCohorts,
  comparisonSourceSignature,
  proportionInterval,
} from "@/src/lib/cohort-comparison";
import { cohortComparisonSchema, defaultCohortComparison } from "@/src/lib/cohort-comparison-model";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";
import { analysisValuesSchema } from "@/src/lib/saved-analysis-model";

const criteria = { ...defaultCohortCriteria, include: ["A"] };
const settings = {
  ...defaultCohortComparison,
  independent: true,
  reference: { ...defaultCohortCriteria, include: ["B"] },
  outcome: { kind: "diagnosis" as const, code: "X" },
};
function patient(group: string, positive: boolean, extra: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private name",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: [group, ...(positive ? ["X"] : [])],
    notes: "Private notes",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...extra,
  });
}
const source = () => [
  ...Array.from({ length: 50 }, (_, i) => patient("A", i < 20)),
  ...Array.from({ length: 50 }, (_, i) => patient("B", i < 30)),
];
describe("local binary cohort comparison", () => {
  it("matches the Yates-corrected reference table and emits only aggregate data", () => {
    const rows = source();
    const result = compareCohorts(rows, "researcher", criteria, settings, 50);
    expect(result.reason).toBe(null);
    expect(result.test?.statistic).toBeCloseTo(3.24, 10);
    expect(result.test?.pValue).toBeCloseTo(0.07186063822585165, 10);
    expect(result.expected).toEqual([
      [25, 25],
      [25, 25],
    ]);
    expect(result.difference).toBeCloseTo(-0.2, 12);
    expect(result.ratio).toBeCloseTo(2 / 3, 12);
    expect(JSON.stringify(result)).not.toMatch(/Private|1990|clientId|birthDate/);
    expect(JSON.stringify(result)).not.toContain(rows[0]!.clientId);
  });
  it("uses exact binomial bounds at both extremes and a known interior value", () => {
    expect(proportionInterval(0, 10, 95)?.lower).toBe(0);
    expect(proportionInterval(0, 10, 95)?.upper).toBeCloseTo(0.3084971078187608, 10);
    expect(proportionInterval(10, 10, 95)?.lower).toBeCloseTo(0.6915028921812392, 10);
    expect(proportionInterval(10, 10, 95)?.upper).toBe(1);
    expect(proportionInterval(5, 10, 95)?.lower).toBeCloseTo(0.1870860284473985, 10);
    expect(proportionInterval(5, 10, 95)?.upper).toBeCloseTo(0.8129139715526015, 10);
    expect(proportionInterval(0, 0, 95)).toBe(null);
    expect(proportionInterval(5, 10, 99)!.lower).toBeLessThan(proportionInterval(5, 10, 90)!.lower);
    expect(proportionInterval(5, 10, 99)!.upper).toBeGreaterThan(
      proportionInterval(5, 10, 90)!.upper,
    );
    expect(() => proportionInterval(2, 1, 95)).toThrow("ANALYSIS_CALCULATION_FAILED");
  });
  it("does not treat withheld, expired, revoked or deleted data as negative observations", () => {
    const rows = [
      patient("A", true, { consentScope: ["sex"] }),
      patient("A", true, { accessExpiresAt: 50 }),
      patient("A", true, { consentApproved: false }),
      patient("A", true, { deleted: true }),
      patient("A", false),
      patient("B", true),
    ];
    const result = compareCohorts(rows, "researcher", { ...criteria, include: [] }, settings, 50);
    expect(result.groups[0]).toMatchObject({ selected: 3, total: 2, unavailable: 1, positive: 1 });
  });
  it("excludes unknown sex from the binary denominator", () => {
    const result = compareCohorts(
      [
        patient("A", true, { sex: "unknown" }),
        patient("A", true, { sex: "male" }),
        patient("B", true),
      ],
      "researcher",
      criteria,
      { ...settings, outcome: { kind: "sex", value: "female" } },
      50,
    );
    expect(result.groups[0]).toMatchObject({ selected: 2, total: 1, positive: 0, unknown: 1 });
  });
  it("suppresses inference for overlapping cohorts", () => {
    expect(
      compareCohorts(source(), "doctor", criteria, { ...settings, reference: criteria }, 50).reason,
    ).toBe("overlap");
  });
  it("suppresses inference for duplicate source identifiers", () => {
    const rows = source();
    rows.push(rows[0]!);
    expect(compareCohorts(rows, "doctor", criteria, settings, 50).reason).toBe("duplicate");
  });
  it("suppresses inference when the tested outcome defines selection", () => {
    expect(
      compareCohorts(source(), "doctor", { ...criteria, exclude: ["x"] }, settings, 50).reason,
    ).toBe("selection");
  });
  it("requires explicit independence and adequate expected frequencies", () => {
    expect(
      compareCohorts(source(), "doctor", criteria, { ...settings, independent: false }, 50).reason,
    ).toBe("independence");
    expect(
      compareCohorts([patient("A", true), patient("B", false)], "doctor", criteria, settings, 50)
        .reason,
    ).toBe("small");
    expect(
      compareCohorts([patient("A", false), patient("B", false)], "doctor", criteria, settings, 50)
        .reason,
    ).toBe("empty");
  });
  it("requires a hypothesis for a prespecified comparison, preserving old definition shape", () => {
    expect(cohortComparisonSchema.safeParse({ ...settings, intent: "prespecified" }).success).toBe(
      false,
    );
    const old = { title: "Old analysis", description: "", criteria };
    expect(analysisValuesSchema.parse(old)).toEqual(old);
    expect(Object.hasOwn(analysisValuesSchema.parse(old), "comparison")).toBe(false);
    expect(analysisValuesSchema.parse({ ...old, comparison: settings }).comparison).toEqual(
      settings,
    );
  });
  it("fingerprints authorized fields only, changes on expiry and ignores ordering", () => {
    const rows = source();
    const before = comparisonSourceSignature(rows, "researcher", 50);
    expect(comparisonSourceSignature([...rows].reverse(), "researcher", 50)).toBe(before);
    expect(
      comparisonSourceSignature(
        rows.map((row) => ({ ...row, fullName: "Other private name" })),
        "researcher",
        50,
      ),
    ).toBe(before);
    expect(comparisonSourceSignature(rows, "researcher", 100)).not.toBe(before);
  });
});
