import { describe, expect, it } from "@rstest/core";

import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import {
  compareCohorts,
  compareFixedCohorts,
  comparisonSourceSignature,
  freezeCohortSample,
  frozenSampleSignature,
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
describe("frozen cohort samples", () => {
  it("freezes sorted membership of both groups and round-trips through the schema", () => {
    const rows = source();
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    expect(fixed.frozenAt).toBe(50);
    expect(fixed.groupIds).toHaveLength(50);
    expect(fixed.referenceIds).toHaveLength(50);
    expect(fixed.groupIds).toEqual([...fixed.groupIds].sort((a, b) => a.localeCompare(b)));
    expect(fixed.referenceIds).toEqual([...fixed.referenceIds].sort((a, b) => a.localeCompare(b)));
    expect(fixed.signature).toBe(frozenSampleSignature(rows, "researcher", fixed, 50));
    const parsed = cohortComparisonSchema.parse({ ...settings, fixedSample: fixed });
    expect(parsed.fixedSample).toEqual(fixed);
    expect(
      analysisValuesSchema.parse({
        title: "Frozen",
        description: "",
        criteria,
        comparison: { ...settings, fixedSample: fixed },
      }).comparison?.fixedSample,
    ).toEqual(fixed);
  });
  it("keeps the frozen composition when selection criteria change afterwards", () => {
    const rows = source();
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    const frozen = { ...settings, fixedSample: fixed };
    const changedCriteria = { ...defaultCohortCriteria, include: ["B"] };
    const result = compareFixedCohorts(rows, "researcher", changedCriteria, frozen, 50);
    expect(result.reason).toBe(null);
    expect(result.frozenAt).toBe(50);
    expect(result.groups[0]).toMatchObject({ selected: 50, total: 50, positive: 20, dropped: 0 });
    expect(result.groups[1]).toMatchObject({ selected: 50, total: 50, positive: 30, dropped: 0 });
    expect(result.test?.statistic).toBeCloseTo(3.24, 10);
    expect(result.test?.pValue).toBeCloseTo(0.07186063822585165, 10);
    expect(result.signature).toBe(fixed.signature);
    expect(JSON.stringify(result)).not.toMatch(/Private|1990|clientId|birthDate/);
    expect(JSON.stringify(result)).not.toContain(rows[0]!.clientId);
  });
  it("matches the live comparison while all frozen members stay authorized", () => {
    const rows = source();
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    const live = compareCohorts(rows, "researcher", criteria, settings, 50);
    const frozen = compareFixedCohorts(
      rows,
      "researcher",
      criteria,
      { ...settings, fixedSample: fixed },
      50,
    );
    expect(frozen.groups).toEqual(live.groups.map((group) => ({ ...group, dropped: 0 })));
    expect(frozen.test).toEqual(live.test);
  });
  it("counts members that lost access as dropped instead of negative observations", () => {
    const rows = source();
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    const mutated = rows.map((row, index) =>
      index === 0
        ? { ...row, deleted: true }
        : index === 50
          ? { ...row, consentApproved: false }
          : index === 1
            ? { ...row, accessExpiresAt: 40 }
            : row,
    );
    const result = compareFixedCohorts(
      mutated,
      "researcher",
      criteria,
      { ...settings, fixedSample: fixed },
      50,
    );
    expect(result.groups[0]).toMatchObject({ selected: 48, dropped: 2 });
    expect(result.groups[1]).toMatchObject({ selected: 49, dropped: 1 });
    expect(result.signature).not.toBe(fixed.signature);
    expect(frozenSampleSignature(mutated, "researcher", fixed, 50)).toBe(result.signature);
  });
  it("fails to freeze an empty group", () => {
    expect(() =>
      freezeCohortSample(
        source(),
        "researcher",
        { ...defaultCohortCriteria, include: ["ZZZ"] },
        settings,
        50,
      ),
    ).toThrow("ANALYSIS_CALCULATION_FAILED");
    expect(() => compareFixedCohorts(source(), "researcher", criteria, settings, 50)).toThrow(
      "ANALYSIS_CALCULATION_FAILED",
    );
  });
  it("keeps the overlap and selection guards for frozen samples", () => {
    const rows = source();
    const overlapping = freezeCohortSample(
      rows,
      "researcher",
      criteria,
      {
        ...settings,
        reference: criteria,
      },
      50,
    );
    expect(
      compareFixedCohorts(
        rows,
        "researcher",
        criteria,
        {
          ...settings,
          reference: criteria,
          fixedSample: overlapping,
        },
        50,
      ).reason,
    ).toBe("overlap");
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    expect(
      compareFixedCohorts(
        rows,
        "researcher",
        { ...criteria, exclude: ["x"] },
        { ...settings, fixedSample: fixed },
        50,
      ).reason,
    ).toBe("selection");
  });
  it("frozen signature ignores unrelated rows and reacts to member changes", () => {
    const rows = source();
    const fixed = freezeCohortSample(rows, "researcher", criteria, settings, 50);
    const before = frozenSampleSignature(rows, "researcher", fixed, 50);
    const unrelated = [...rows, patient("C", true)];
    expect(frozenSampleSignature(unrelated, "researcher", fixed, 50)).toBe(before);
    const renamed = rows.map((row) => ({ ...row, fullName: "Other private name" }));
    expect(frozenSampleSignature(renamed, "researcher", fixed, 50)).toBe(before);
    const revised = rows.map((row, index) => (index === 0 ? { ...row, revision: 2 } : row));
    expect(frozenSampleSignature(revised, "researcher", fixed, 50)).not.toBe(before);
  });
});
