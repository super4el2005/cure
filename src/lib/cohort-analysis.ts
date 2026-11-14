import { z } from "zod";

import type { PatientRow } from "@/src/lib/patient-model";

export const cohortCriteriaSchema = z.object({
  include: z.array(z.string().trim().min(1).max(50)).max(100),
  exclude: z.array(z.string().trim().min(1).max(50)).max(100),
  diagnosisMatch: z.enum(["any", "all"]),
  sex: z.enum(["any", "female", "male", "unknown"]),
});
export type CohortCriteria = z.infer<typeof cohortCriteriaSchema>;
export const defaultCohortCriteria: CohortCriteria = {
  include: [],
  exclude: [],
  diagnosisMatch: "any",
  sex: "any",
};
const normalize = (codes: readonly string[]) => [
  ...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean)),
];

type Disposition = "unavailableFields" | "sex" | "excluded" | "inclusion" | "selected";
// Shared selection semantics for descriptive summaries and group comparisons.
export function* cohortEntries(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  input: CohortCriteria,
  now: number,
) {
  const criteria = cohortCriteriaSchema.parse(input);
  const include = normalize(criteria.include);
  const exclude = normalize(criteria.exclude);
  for (const row of source) {
    if (
      row.deleted ||
      (role === "researcher" &&
        (!row.consentApproved || !row.accessExpiresAt || row.accessExpiresAt <= now))
    )
      continue;
    const canSex = role === "doctor" || row.consentScope.includes("sex");
    const canDiagnoses = role === "doctor" || row.consentScope.includes("diagnoses");
    if (!canSex && !canDiagnoses) continue;
    const codes = canDiagnoses ? normalize(row.diagnosisCodes) : [];
    let reason: Disposition = "selected";
    if (
      (criteria.sex !== "any" && !canSex) ||
      ((include.length > 0 || exclude.length > 0) && !canDiagnoses)
    )
      reason = "unavailableFields";
    else if (criteria.sex !== "any" && row.sex !== criteria.sex) reason = "sex";
    else if (exclude.some((code) => codes.includes(code))) reason = "excluded";
    else if (
      include.length > 0 &&
      !(criteria.diagnosisMatch === "all"
        ? include.every((code) => codes.includes(code))
        : include.some((code) => codes.includes(code)))
    )
      reason = "inclusion";
    yield { row, canSex, canDiagnoses, codes, reason };
  }
}
// A descriptive local view, never a mutation of clinical records.
export function analyzeCohort(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  input: CohortCriteria,
  now: number,
) {
  const flow = {
    available: 0,
    unavailableFields: 0,
    sex: 0,
    excluded: 0,
    inclusion: 0,
    selected: 0,
  };
  const sexCounts = { female: 0, male: 0, unknown: 0 };
  const diagnoses = new Map<string, number>();
  const availableCodes = new Set<string>();
  let sexDenominator = 0;
  let diagnosisDenominator = 0;
  let emptyDiagnoses = 0;
  for (const { row, canSex, canDiagnoses, codes, reason } of cohortEntries(
    source,
    role,
    input,
    now,
  )) {
    for (const code of codes) availableCodes.add(code);
    flow.available++;
    if (reason !== "selected") {
      flow[reason]++;
      continue;
    }
    flow.selected++;
    if (canSex) {
      sexDenominator++;
      sexCounts[row.sex]++;
    }
    if (canDiagnoses) {
      diagnosisDenominator++;
      if (codes.length === 0) emptyDiagnoses++;
      for (const code of codes) diagnoses.set(code, (diagnoses.get(code) ?? 0) + 1);
    }
  }
  return {
    flow,
    sexCounts,
    sexDenominator,
    diagnosisDenominator,
    emptyDiagnoses,
    unavailableSex: flow.selected - sexDenominator,
    unavailableDiagnoses: flow.selected - diagnosisDenominator,
    availableCodes: [...availableCodes].sort(),
    diagnoses: [...diagnoses]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}
