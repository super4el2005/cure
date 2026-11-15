import betaQuantile from "@stdlib/stats-base-dists-beta-quantile";
import chi2test from "@stdlib/stats-chi2test";
import { hash } from "ohash";

import { cohortEntries } from "@/src/lib/cohort-analysis";
import type { CohortCriteria } from "@/src/lib/cohort-analysis";
import { cohortComparisonSchema } from "@/src/lib/cohort-comparison-model";
import type { CohortComparison, FixedSample } from "@/src/lib/cohort-comparison-model";
import type { PatientRow } from "@/src/lib/patient-model";

const emptySelection: CohortCriteria = {
  include: [],
  exclude: [],
  diagnosisMatch: "any",
  sex: "any",
};

export function proportionInterval(positive: number, total: number, confidence: 90 | 95 | 99) {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(positive) ||
    positive < 0 ||
    total < positive
  )
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  if (!total) return null;
  const alpha = (1 - confidence / 100) / 2;
  const lower = positive === 0 ? 0 : betaQuantile(alpha, positive, total - positive + 1);
  const upper = positive === total ? 1 : betaQuantile(1 - alpha, positive + 1, total - positive);
  if (!Number.isFinite(lower) || !Number.isFinite(upper))
    throw new Error("ANALYSIS_CALCULATION_FAILED");
  return { proportion: positive / total, lower, upper };
}

// Only authorized analytical fields enter this local freshness fingerprint.
// The hash is neither an anonymization guarantee nor a transmitted identifier.
export function comparisonSourceSignature(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  now: number,
) {
  return hash(
    [...cohortEntries(source, role, emptySelection, now)]
      .map(({ row, canSex, canDiagnoses, codes }) => [
        row.clientId,
        row.revision,
        canSex ? row.sex : null,
        canDiagnoses ? codes : null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

// Freshness fingerprint limited to the frozen members that are still authorized.
export function frozenSampleSignature(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  fixed: FixedSample,
  now: number,
) {
  const wanted = new Set([...fixed.groupIds, ...fixed.referenceIds]);
  return hash(
    [...cohortEntries(source, role, emptySelection, now)]
      .filter((entry) => wanted.has(entry.row.clientId))
      .map(({ row, canSex, canDiagnoses, codes }) => [
        row.clientId,
        row.revision,
        canSex ? row.sex : null,
        canDiagnoses ? codes : null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

export function compareCohorts(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  input: CohortComparison,
  now: number,
) {
  const settings = cohortComparisonSchema.parse(input);
  const groups = [criteria, settings.reference].map((selection) => {
    const ids = new Set<string>();
    let positive = 0,
      total = 0,
      unavailable = 0,
      unknown = 0,
      duplicate = false;
    for (const entry of cohortEntries(source, role, selection, now)) {
      if (entry.reason !== "selected") continue;
      if (ids.has(entry.row.clientId)) duplicate = true;
      ids.add(entry.row.clientId);
      if (settings.outcome.kind === "diagnosis") {
        if (!entry.canDiagnoses) {
          unavailable++;
          continue;
        }
        total++;
        if (entry.codes.includes(settings.outcome.code.toUpperCase())) positive++;
      } else {
        if (!entry.canSex) {
          unavailable++;
          continue;
        }
        if (entry.row.sex === "unknown") {
          unknown++;
          continue;
        }
        total++;
        if (entry.row.sex === settings.outcome.value) positive++;
      }
    }
    return {
      ids,
      duplicate,
      selected: ids.size,
      positive,
      total,
      unavailable,
      unknown,
      dropped: 0,
      interval: proportionInterval(positive, total, settings.confidence),
    };
  });
  const [first, second] = groups as [(typeof groups)[number], (typeof groups)[number]];
  const overlap = [...first.ids].filter((id) => second.ids.has(id)).length;
  const selectedOutcome = [criteria, settings.reference].some((selection) =>
    settings.outcome.kind === "sex"
      ? selection.sex !== "any"
      : [...selection.include, ...selection.exclude].some(
          (code) =>
            code.trim().toUpperCase() ===
            (settings.outcome.kind === "diagnosis" ? settings.outcome.code.toUpperCase() : ""),
        ),
  );
  const table = [
    [first.positive, first.total - first.positive],
    [second.positive, second.total - second.positive],
  ];
  const total = first.total + second.total;
  const columns = [
    first.positive + second.positive,
    first.total + second.total - first.positive - second.positive,
  ];
  const expected = table.map((row) =>
    columns.map((column) => (total ? ((row[0]! + row[1]!) * column) / total : 0)),
  );
  const reason: "duplicate" | "overlap" | "selection" | "independence" | "empty" | "small" | null =
    first.duplicate || second.duplicate
      ? "duplicate"
      : overlap
        ? "overlap"
        : selectedOutcome
          ? "selection"
          : !settings.independent
            ? "independence"
            : !first.total || !second.total || columns.some((n) => n === 0)
              ? "empty"
              : expected.flat().some((n) => n < 5)
                ? "small"
                : null;
  let test: { statistic: number; pValue: number; df: number } | null = null;
  if (!reason) {
    const result = chi2test(table, { correct: true, alpha: 1 - settings.confidence / 100 });
    if (!Number.isFinite(result.pValue) || !Number.isFinite(result.statistic))
      throw new Error("ANALYSIS_CALCULATION_FAILED");
    test = { statistic: result.statistic, pValue: result.pValue, df: result.df };
  }
  const difference =
    first.interval && second.interval
      ? first.interval.proportion - second.interval.proportion
      : null;
  const ratio =
    first.interval && second.interval && second.interval.proportion > 0
      ? first.interval.proportion / second.interval.proportion
      : null;
  // Never expose patient rows or IDs in the aggregate result.
  return {
    groups:
      reason === "duplicate"
        ? []
        : groups.map(({ ids: _ids, duplicate: _duplicate, ...group }) => group),
    overlap,
    reason,
    expected,
    test,
    difference: reason === "duplicate" ? null : difference,
    ratio: reason === "duplicate" ? null : ratio,
    calculatedAt: now,
    frozenAt: null,
    signature: comparisonSourceSignature(source, role, now),
  };
}

// Freezes the current group membership; values are still read live at calculation time.
export function freezeCohortSample(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  input: CohortComparison,
  now: number,
): FixedSample {
  const settings = cohortComparisonSchema.parse(input);
  const collect = (selection: CohortCriteria) => {
    const ids = new Set<string>();
    for (const entry of cohortEntries(source, role, selection, now))
      if (entry.reason === "selected") ids.add(entry.row.clientId);
    if (!ids.size) throw new Error("ANALYSIS_CALCULATION_FAILED");
    return [...ids].sort((a, b) => a.localeCompare(b));
  };
  const groupIds = collect(criteria);
  const referenceIds = collect(settings.reference);
  const fixed: FixedSample = { frozenAt: now, groupIds, referenceIds, signature: "" };
  return { ...fixed, signature: frozenSampleSignature(source, role, fixed, now) };
}

// Compares the frozen membership on currently authorized values, not on a value snapshot.
export function compareFixedCohorts(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  criteria: CohortCriteria,
  input: CohortComparison,
  now: number,
) {
  const settings = cohortComparisonSchema.parse(input);
  const fixed = settings.fixedSample;
  if (!fixed) throw new Error("ANALYSIS_CALCULATION_FAILED");
  const groups = [fixed.groupIds, fixed.referenceIds].map((frozenIds) => {
    const wanted = new Set(frozenIds);
    const ids = new Set<string>();
    let positive = 0,
      total = 0,
      unavailable = 0,
      unknown = 0,
      duplicate = false;
    for (const entry of cohortEntries(source, role, emptySelection, now)) {
      if (!wanted.has(entry.row.clientId)) continue;
      if (ids.has(entry.row.clientId)) duplicate = true;
      ids.add(entry.row.clientId);
      if (settings.outcome.kind === "diagnosis") {
        if (!entry.canDiagnoses) {
          unavailable++;
          continue;
        }
        total++;
        if (entry.codes.includes(settings.outcome.code.toUpperCase())) positive++;
      } else {
        if (!entry.canSex) {
          unavailable++;
          continue;
        }
        if (entry.row.sex === "unknown") {
          unknown++;
          continue;
        }
        total++;
        if (entry.row.sex === settings.outcome.value) positive++;
      }
    }
    return {
      ids,
      duplicate,
      selected: ids.size,
      positive,
      total,
      unavailable,
      unknown,
      dropped: wanted.size - ids.size,
      interval: proportionInterval(positive, total, settings.confidence),
    };
  });
  const [first, second] = groups as [(typeof groups)[number], (typeof groups)[number]];
  const overlap = [...first.ids].filter((id) => second.ids.has(id)).length;
  const selectedOutcome = [criteria, settings.reference].some((selection) =>
    settings.outcome.kind === "sex"
      ? selection.sex !== "any"
      : [...selection.include, ...selection.exclude].some(
          (code) =>
            code.trim().toUpperCase() ===
            (settings.outcome.kind === "diagnosis" ? settings.outcome.code.toUpperCase() : ""),
        ),
  );
  const table = [
    [first.positive, first.total - first.positive],
    [second.positive, second.total - second.positive],
  ];
  const total = first.total + second.total;
  const columns = [
    first.positive + second.positive,
    first.total + second.total - first.positive - second.positive,
  ];
  const expected = table.map((row) =>
    columns.map((column) => (total ? ((row[0]! + row[1]!) * column) / total : 0)),
  );
  const reason: "duplicate" | "overlap" | "selection" | "independence" | "empty" | "small" | null =
    first.duplicate || second.duplicate
      ? "duplicate"
      : overlap
        ? "overlap"
        : selectedOutcome
          ? "selection"
          : !settings.independent
            ? "independence"
            : !first.total || !second.total || columns.some((n) => n === 0)
              ? "empty"
              : expected.flat().some((n) => n < 5)
                ? "small"
                : null;
  let test: { statistic: number; pValue: number; df: number } | null = null;
  if (!reason) {
    const result = chi2test(table, { correct: true, alpha: 1 - settings.confidence / 100 });
    if (!Number.isFinite(result.pValue) || !Number.isFinite(result.statistic))
      throw new Error("ANALYSIS_CALCULATION_FAILED");
    test = { statistic: result.statistic, pValue: result.pValue, df: result.df };
  }
  const difference =
    first.interval && second.interval
      ? first.interval.proportion - second.interval.proportion
      : null;
  const ratio =
    first.interval && second.interval && second.interval.proportion > 0
      ? first.interval.proportion / second.interval.proportion
      : null;
  // Never expose patient rows or IDs in the aggregate result.
  return {
    groups:
      reason === "duplicate"
        ? []
        : groups.map(({ ids: _ids, duplicate: _duplicate, ...group }) => group),
    overlap,
    reason,
    expected,
    test,
    difference: reason === "duplicate" ? null : difference,
    ratio: reason === "duplicate" ? null : ratio,
    calculatedAt: now,
    frozenAt: fixed.frozenAt,
    signature: frozenSampleSignature(source, role, fixed, now),
  };
}
