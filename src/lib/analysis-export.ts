import type { compareCohorts, compareFixedCohorts } from "@/src/lib/cohort-comparison";
import type { cohortLongitudinal } from "@/src/lib/cohort-longitudinal";
import type { cohortStatistics } from "@/src/lib/cohort-statistics";

// Aggregate-only exports: these builders accept the same de-identified
// reports the interface shows and never see patient rows or identifiers.
// Numbers keep full precision with a locale-independent decimal point.

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
export function csvLines(rows: readonly (readonly (string | number | null)[])[]) {
  return rows
    .map((row) => row.map((cell) => csvCell(cell === null ? "" : String(cell))).join(","))
    .join("\n");
}

type ComparisonReport = ReturnType<typeof compareCohorts> | ReturnType<typeof compareFixedCohorts>;
type StatisticsReport = ReturnType<typeof cohortStatistics>;
type LongitudinalReport = ReturnType<typeof cohortLongitudinal>;

// Tidy long format: one value per row, sections never reshape the table.
export function comparisonReportCsv(
  report: ComparisonReport,
  groupLabels: readonly [string, string],
) {
  const rows: (string | number | null)[][] = [
    ["section", "item", "statistic", "value"],
    ["meta", "calculatedAt", "iso", new Date(report.calculatedAt).toISOString()],
    [
      "meta",
      "frozenAt",
      "iso",
      report.frozenAt === null ? null : new Date(report.frozenAt).toISOString(),
    ],
    ["meta", "overlap", "count", report.overlap],
    ["meta", "reason", "code", report.reason],
    ["meta", "difference", "proportion", report.difference],
    ["meta", "ratio", "value", report.ratio],
  ];
  report.groups.forEach((group, index) => {
    const label = groupLabels[index] ?? `group-${index + 1}`;
    rows.push(
      ["group", label, "selected", group.selected],
      ["group", label, "positive", group.positive],
      ["group", label, "total", group.total],
      ["group", label, "proportion", group.interval?.proportion ?? null],
      ["group", label, "ciLower", group.interval?.lower ?? null],
      ["group", label, "ciUpper", group.interval?.upper ?? null],
      ["group", label, "unavailable", group.unavailable],
      ["group", label, "unknown", group.unknown],
      ["group", label, "dropped", group.dropped],
    );
  });
  report.expected.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) =>
      rows.push(["expected", `row-${rowIndex + 1}`, `column-${columnIndex + 1}`, value]),
    ),
  );
  if (report.test)
    rows.push(
      ["test", "chi2", "statistic", report.test.statistic],
      ["test", "chi2", "pValue", report.test.pValue],
      ["test", "chi2", "df", report.test.df],
    );
  return `${csvLines(rows)}\n`;
}

export function statisticsReportCsv(
  report: StatisticsReport,
  codes: { primary: string; secondary: string },
) {
  const rows: (string | number | null)[][] = [
    ["section", "item", "statistic", "value"],
    ["meta", "calculatedAt", "iso", new Date(report.calculatedAt).toISOString()],
    ["meta", "members", "count", report.members],
    ["meta", "withPrimary", "count", report.withPrimary],
  ];
  const indicators = [
    { code: codes.primary, stats: report.primary },
    { code: codes.secondary, stats: report.secondary },
  ] as const;
  for (const { code, stats } of indicators) {
    if (!stats) continue;
    rows.push(
      ["indicator", code, "n", stats.n],
      ["indicator", code, "mean", stats.mean],
      ["indicator", code, "sd", stats.sd],
      ["indicator", code, "min", stats.min],
      ["indicator", code, "q1", stats.q1],
      ["indicator", code, "median", stats.median],
      ["indicator", code, "q3", stats.q3],
      ["indicator", code, "max", stats.max],
    );
  }
  if (report.correlation)
    rows.push(
      ["correlation", `${codes.primary}~${codes.secondary}`, "n", report.correlation.n],
      ["correlation", `${codes.primary}~${codes.secondary}`, "r", report.correlation.r],
      ["correlation", `${codes.primary}~${codes.secondary}`, "reason", report.correlation.reason],
    );
  return `${csvLines(rows)}\n`;
}

export function longitudinalReportCsv(report: LongitudinalReport, code: string) {
  return `${csvLines([
    ["indicator", "period", "observations", "patients", "mean", "median", "min", "max"],
    ...report.series.map((period) => [
      code,
      period.key,
      period.n,
      period.patients,
      period.mean,
      period.median,
      period.min,
      period.max,
    ]),
  ])}\n`;
}

// Browser-only download helper; report builders above stay DOM-free.
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
