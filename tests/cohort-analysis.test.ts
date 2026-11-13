import { describe, expect, it } from "@rstest/core";

import { analyzeCohort, defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";

function patient(values: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private name",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: ["F41"],
    notes: "Private note",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...values,
  });
}
describe("consent-aware descriptive cohort", () => {
  it("counts diagnoses once per patient, separates authorized missing values, and never returns identifiers", () => {
    const source = [
      patient({ diagnosisCodes: ["f41", " F41 ", "F41.1"] }),
      patient({ sex: "unknown", diagnosisCodes: [] }),
      patient({ sex: "male", diagnosisCodes: ["F41.1"] }),
    ];
    const before = JSON.stringify(source);
    const result = analyzeCohort(source, "researcher", defaultCohortCriteria, 50);
    expect(result.flow.selected).toBe(3);
    expect(result.diagnoses).toEqual([
      { code: "F41.1", count: 2 },
      { code: "F41", count: 1 },
    ]);
    expect(result.emptyDiagnoses).toBe(1);
    expect(result.sexCounts).toEqual({ female: 1, male: 1, unknown: 1 });
    expect(JSON.stringify(result)).not.toMatch(/Private|1990|clientId|birthDate/);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("does not confuse fields withheld by consent with clinical missingness", () => {
    const source = [
      patient({ consentScope: ["sex"], diagnosisCodes: ["WITHHELD"] }),
      patient({ consentScope: ["diagnoses"] }),
    ];
    const result = analyzeCohort(source, "researcher", defaultCohortCriteria, 50);
    expect(result.flow.selected).toBe(2);
    expect(result.sexDenominator).toBe(1);
    expect(result.diagnosisDenominator).toBe(1);
    expect(result.emptyDiagnoses).toBe(0);
    expect(result.unavailableSex).toBe(1);
    expect(result.unavailableDiagnoses).toBe(1);
    expect(JSON.stringify(result)).not.toContain("WITHHELD");
    const filtered = analyzeCohort(
      source,
      "researcher",
      { ...defaultCohortCriteria, exclude: ["F41"] },
      50,
    );
    expect(filtered.flow).toMatchObject({
      available: 2,
      unavailableFields: 1,
      excluded: 1,
      selected: 0,
    });
  });
  it("rechecks consent expiry and deletion; doctors can analyze their own authorized workspace", () => {
    const source = [
      patient({ accessExpiresAt: 50 }),
      patient({ consentApproved: false }),
      patient({ consentScope: [] }),
      patient({ deleted: true }),
    ];
    expect(analyzeCohort(source, "researcher", defaultCohortCriteria, 50).flow.available).toBe(0);
    expect(analyzeCohort(source, "doctor", defaultCohortCriteria, 50).flow.available).toBe(3);
  });
  it("applies exact-code ANY/ALL inclusion, exclusion precedence and a reproducible flow", () => {
    const source = [
      patient({ diagnosisCodes: ["F41", "F41.1"] }),
      patient({ sex: "male" }),
      patient({ diagnosisCodes: ["F41.1"] }),
      patient({ diagnosisCodes: ["F41", "F32"] }),
      patient({ consentScope: ["sex"] }),
    ];
    const criteria = {
      ...defaultCohortCriteria,
      sex: "female" as const,
      include: ["f41", "F41.1"],
      exclude: ["F32"],
      diagnosisMatch: "all" as const,
    };
    const result = analyzeCohort(source, "researcher", criteria, 50);
    expect(result.flow).toEqual({
      available: 5,
      unavailableFields: 1,
      sex: 1,
      excluded: 1,
      inclusion: 1,
      selected: 1,
    });
    expect(
      analyzeCohort(source, "researcher", { ...criteria, diagnosisMatch: "any" }, 50).flow.selected,
    ).toBe(2);
    expect(
      analyzeCohort(source, "researcher", { ...defaultCohortCriteria, include: ["F41"] }, 50).flow
        .selected,
    ).toBe(3);
    expect(
      analyzeCohort(source, "researcher", { ...defaultCohortCriteria, include: ["F"] }, 50).flow
        .selected,
    ).toBe(0);
  });
});
