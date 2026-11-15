import { z } from "zod";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { CohortCriteria } from "@/src/lib/cohort-analysis";
import { descriptiveStatistics } from "@/src/lib/cohort-statistics";
import { cohortMemberIds, statisticsSourceSignature } from "@/src/lib/cohort-statistics";
import type { PatientRow } from "@/src/lib/patient-model";

export const cohortLongitudinalSchema = z.object({
  calculationVersion: z.literal("cohort-longitudinal-v1"),
  code: z.string().trim().min(1).max(100),
  bucket: z.enum(["month", "quarter"]),
});
export type CohortLongitudinalInput = z.infer<typeof cohortLongitudinalSchema>;
export const defaultCohortLongitudinal: CohortLongitudinalInput = {
  calculationVersion: "cohort-longitudinal-v1",
  code: "",
  bucket: "month",
};

// Calendar bucket of an ISO date: "2025-03" or "2025-Q1".
export function longitudinalBucket(occurredOn: string, bucket: "month" | "quarter") {
  if (bucket === "month") return occurredOn.slice(0, 7);
  const month = Number(occurredOn.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12)
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  return `${occurredOn.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}

export type LongitudinalPeriod = {
  key: string;
  n: number;
  patients: number;
  mean: number;
  median: number;
  min: number;
  max: number;
};

// Aggregate dynamics of one observation code over calendar periods.
// Repeated measurements of one patient are the point of this view:
// every numeric value enters its period, while per-period and overall
// patient counts keep the repeated design explicit. Aggregate output only.
export function cohortLongitudinal(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  records: readonly ClinicalRecord[],
  input: CohortLongitudinalInput,
  now: number,
) {
  const settings = cohortLongitudinalSchema.parse(input);
  const memberIds = cohortMemberIds(source, role, criteria, now);
  const code = settings.code.trim();
  const periods = new Map<string, { values: number[]; patients: Set<string> }>();
  const patients = new Set<string>();
  let observations = 0;
  for (const record of records) {
    if (record.deleted || record.payload?.kind !== "observation") continue;
    if (!memberIds.has(record.patientClientId)) continue;
    if (record.payload.code.trim() !== code || record.payload.numericValue === null) continue;
    const key = longitudinalBucket(record.payload.occurredOn, settings.bucket);
    const period = periods.get(key) ?? { values: [], patients: new Set<string>() };
    period.values.push(record.payload.numericValue);
    period.patients.add(record.patientClientId);
    periods.set(key, period);
    patients.add(record.patientClientId);
    observations++;
  }
  const series: LongitudinalPeriod[] = [...periods]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, period]) => {
      const stats = descriptiveStatistics(period.values);
      if (!stats) throw new Error("ANALYSIS_CALCULATION_FAILED");
      return {
        key,
        n: stats.n,
        patients: period.patients.size,
        mean: stats.mean,
        median: stats.median,
        min: stats.min,
        max: stats.max,
      };
    });
  return {
    series,
    members: memberIds.size,
    patients: patients.size,
    observations,
    calculatedAt: now,
    signature: statisticsSourceSignature(source, role, criteria, records, now),
  };
}
