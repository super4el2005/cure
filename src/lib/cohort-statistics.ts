import { hash } from "ohash";
import { z } from "zod";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import { cohortEntries } from "@/src/lib/cohort-analysis";
import type { CohortCriteria } from "@/src/lib/cohort-analysis";
import type { PatientRow } from "@/src/lib/patient-model";

export const cohortStatisticsSchema = z.object({
  calculationVersion: z.literal("cohort-stats-v1"),
  primary: z.string().trim().min(1).max(100),
  secondary: z.string().trim().max(100),
});
export type CohortStatisticsInput = z.infer<typeof cohortStatisticsSchema>;
export const defaultCohortStatistics: CohortStatisticsInput = {
  calculationVersion: "cohort-stats-v1",
  primary: "",
  secondary: "",
};

// Members of the cohort under the shared selection semantics.
export function cohortMemberIds(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  now: number,
) {
  const ids = new Set<string>();
  for (const entry of cohortEntries(source, role, criteria, now))
    if (entry.reason === "selected") ids.add(entry.row.clientId);
  return ids;
}

// Latest numeric observation per patient for one exact observation code.
// Repeated measurements of one patient never sum into the sample.
export function observationValues(
  records: readonly ClinicalRecord[],
  memberIds: ReadonlySet<string>,
  code: string,
) {
  const wanted = code.trim();
  const latest = new Map<string, { occurredOn: string; updatedAt: number; value: number }>();
  for (const record of records) {
    if (record.deleted || record.payload?.kind !== "observation") continue;
    if (!memberIds.has(record.patientClientId)) continue;
    const { code: recordCode, numericValue, occurredOn } = record.payload;
    if (recordCode.trim() !== wanted || numericValue === null) continue;
    const current = latest.get(record.patientClientId);
    if (
      !current ||
      occurredOn > current.occurredOn ||
      (occurredOn === current.occurredOn && record.updatedAt > current.updatedAt)
    )
      latest.set(record.patientClientId, {
        occurredOn,
        updatedAt: record.updatedAt,
        value: numericValue,
      });
  }
  return new Map([...latest].map(([id, entry]) => [id, entry.value]));
}

// Distinct observation codes with at least one numeric value among members.
export function availableObservationCodes(
  records: readonly ClinicalRecord[],
  memberIds: ReadonlySet<string>,
) {
  const codes = new Set<string>();
  for (const record of records) {
    if (record.deleted || record.payload?.kind !== "observation") continue;
    if (!memberIds.has(record.patientClientId)) continue;
    const code = record.payload.code.trim();
    if (code && record.payload.numericValue !== null) codes.add(code);
  }
  return [...codes].sort((a, b) => a.localeCompare(b));
}

export type DescriptiveStatistics = {
  n: number;
  mean: number;
  sd: number | null;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
};

// Type-7 quantiles (R/NumPy default) on the sorted sample.
export function descriptiveStatistics(values: readonly number[]): DescriptiveStatistics | null {
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return null;
  const quantile = (p: number) => {
    const h = (n - 1) * p;
    const lower = Math.floor(h);
    const base = sorted[lower]!;
    return lower + 1 < n ? base + (h - lower) * (sorted[lower + 1]! - base) : base;
  };
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  const sd =
    n < 2 ? null : Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1));
  if (!Number.isFinite(mean) || (sd !== null && !Number.isFinite(sd)))
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  return {
    n,
    mean,
    sd,
    min: sorted[0]!,
    q1: quantile(0.25),
    median: quantile(0.5),
    q3: quantile(0.75),
    max: sorted[n - 1]!,
  };
}

// Descriptive Pearson coefficient only; no significance test is attached.
export type CorrelationResult = {
  reason: "small" | "constant" | "same" | null;
  n: number;
  r: number | null;
};
export function pearsonCorrelation(
  pairs: readonly (readonly [number, number])[],
): CorrelationResult {
  if (pairs.flat().some((value) => !Number.isFinite(value)))
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  if (pairs.length < 3) return { reason: "small" as const, n: pairs.length, r: null };
  const n = pairs.length;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
    sxy += (x - meanX) * (y - meanY);
  }
  if (sxx === 0 || syy === 0) return { reason: "constant" as const, n, r: null };
  const r = sxy / Math.sqrt(sxx * syy);
  if (!Number.isFinite(r)) throw new Error("ANALYSIS_CALCULATION_FAILED");
  return { reason: null, n, r };
}

// Freshness fingerprint of cohort membership and members' observation revisions.
export function statisticsSourceSignature(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  records: readonly ClinicalRecord[],
  now: number,
) {
  const memberIds = cohortMemberIds(source, role, criteria, now);
  return hash({
    members: [...memberIds].sort(),
    records: records
      .filter(
        (record) => record.payload?.kind === "observation" && memberIds.has(record.patientClientId),
      )
      .map((record) => [record.clientId, record.revision, record.deleted])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}

// Aggregate-only report; patient identifiers never leave the calculation.
export function cohortStatistics(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  records: readonly ClinicalRecord[],
  input: CohortStatisticsInput,
  now: number,
) {
  const settings = cohortStatisticsSchema.parse(input);
  const memberIds = cohortMemberIds(source, role, criteria, now);
  const primaryValues = observationValues(records, memberIds, settings.primary);
  const primary = descriptiveStatistics([...primaryValues.values()]);
  let secondary = null as DescriptiveStatistics | null;
  let correlation = null as CorrelationResult | null;
  const secondaryCode = settings.secondary.trim();
  if (secondaryCode) {
    if (secondaryCode === settings.primary.trim()) {
      correlation = { reason: "same", n: 0, r: null };
    } else {
      const secondaryValues = observationValues(records, memberIds, secondaryCode);
      secondary = descriptiveStatistics([...secondaryValues.values()]);
      const pairs = [...primaryValues].flatMap(([id, value]) => {
        const other = secondaryValues.get(id);
        return other === undefined ? [] : [[value, other] as const];
      });
      correlation = pearsonCorrelation(pairs);
    }
  }
  return {
    primary,
    secondary,
    correlation,
    members: memberIds.size,
    withPrimary: primaryValues.size,
    calculatedAt: now,
    signature: statisticsSourceSignature(source, role, criteria, records, now),
  };
}
