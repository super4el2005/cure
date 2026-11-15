import { describe, expect, it } from "@rstest/core";

import {
  comparisonReportCsv,
  csvLines,
  longitudinalReportCsv,
  statisticsReportCsv,
} from "@/src/lib/analysis-export";
import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { compareCohorts } from "@/src/lib/cohort-comparison";
import { defaultCohortComparison } from "@/src/lib/cohort-comparison-model";
import { cohortLongitudinal, defaultCohortLongitudinal } from "@/src/lib/cohort-longitudinal";
import { cohortStatistics, defaultCohortStatistics } from "@/src/lib/cohort-statistics";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";

const criteria = { ...defaultCohortCriteria, include: ["A"] };
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
const patients = () => [
  ...Array.from({ length: 50 }, (_, i) => patient("A", i < 20)),
  ...Array.from({ length: 50 }, (_, i) => patient("B", i < 30)),
];
const comparisonSettings = {
  ...defaultCohortComparison,
  independent: true,
  reference: { ...defaultCohortCriteria, include: ["B"] },
  outcome: { kind: "diagnosis" as const, code: "X" },
};
function observation(patientClientId: string, code: string, value: number, occurredOn: string) {
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
      numericValue: value,
      textValue: "",
      unit: "%",
    },
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("csv escaping", () => {
  it("quotes cells with separators, quotes and newlines, empties nulls", () => {
    expect(csvLines([["plain", "with,comma", 'with"quote', "with\nline", null, 1.5]])).toBe(
      'plain,"with,comma","with""quote","with\nline",,1.5',
    );
  });
});
describe("aggregate csv exports", () => {
  it("exports the comparison report in tidy long format without identifiers", () => {
    const rows = patients();
    const report = compareCohorts(rows, "researcher", criteria, comparisonSettings, 50);
    const csv = comparisonReportCsv(report, ["Main", "Reference"]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("section,item,statistic,value");
    expect(csv).toContain("group,Main,selected,50");
    expect(csv).toContain("group,Main,positive,20");
    expect(csv).toContain("group,Reference,positive,30");
    expect(csv).toContain("test,chi2,pValue,");
    expect(csv).toContain("meta,frozenAt,iso,");
    expect(csv).not.toMatch(/Private|1990/);
    expect(csv).not.toContain(rows[0]!.clientId);
    expect(csv.endsWith("\n")).toBe(true);
  });
  it("exports statistics and correlation rows", () => {
    const members = [patient("A", true), patient("A", false), patient("A", true)];
    const records = [
      observation(members[0]!.clientId, "HbA1c", 6.0, "2025-01-10"),
      observation(members[1]!.clientId, "HbA1c", 7.0, "2025-01-10"),
      observation(members[2]!.clientId, "HbA1c", 8.0, "2025-01-10"),
      observation(members[0]!.clientId, "LDL", 2.0, "2025-01-10"),
      observation(members[1]!.clientId, "LDL", 3.0, "2025-01-10"),
      observation(members[2]!.clientId, "LDL", 4.0, "2025-01-10"),
    ];
    const report = cohortStatistics(
      members,
      "doctor",
      criteria,
      records,
      { ...defaultCohortStatistics, primary: "HbA1c", secondary: "LDL" },
      50,
    );
    const csv = statisticsReportCsv(report, { primary: "HbA1c", secondary: "LDL" });
    expect(csv).toContain("indicator,HbA1c,n,3");
    expect(csv).toContain("indicator,LDL,mean,3");
    expect(csv).toContain("correlation,HbA1c~LDL,r,1");
    expect(csv).toContain("correlation,HbA1c~LDL,reason,");
    expect(csv).not.toMatch(/Private|Glycated/);
    expect(csv).not.toContain(members[0]!.clientId);
  });
  it("exports the longitudinal series table", () => {
    const members = [patient("A", true)];
    const records = [
      observation(members[0]!.clientId, "HbA1c", 6.0, "2025-01-10"),
      observation(members[0]!.clientId, "HbA1c", 7.0, "2025-02-10"),
    ];
    const report = cohortLongitudinal(
      members,
      "doctor",
      criteria,
      records,
      { ...defaultCohortLongitudinal, code: "HbA1c" },
      50,
    );
    const csv = longitudinalReportCsv(report, "HbA1c");
    const lines = csv.split("\n");
    expect(lines[0]).toBe("indicator,period,observations,patients,mean,median,min,max");
    expect(lines[1]).toBe("HbA1c,2025-01,1,1,6,6,6,6");
    expect(lines[2]).toBe("HbA1c,2025-02,1,1,7,7,7,7");
    expect(csv).not.toContain(members[0]!.clientId);
  });
});
