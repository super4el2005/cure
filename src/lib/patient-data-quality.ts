import { hash } from "ohash";
import { z } from "zod";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { QualityReviewPayload } from "@/src/lib/data-quality-model";
import type { qualityCodes } from "@/src/lib/data-quality-model";
import { formAnswersSchema } from "@/src/lib/study-form-model";
import { visitTime } from "@/src/lib/visit-time";

type QualityPatient = {
  clientId: string;
  revision: number;
  historyId?: string;
  deleted: boolean;
  fullName: string;
  birthDate: string;
  sex: string;
  diagnosisCodes: string[];
  notes: string;
};
export type QualityFinding = {
  key: string;
  code: (typeof qualityCodes)[number];
  level: "documentation" | "review" | "followUp";
  recordIds: string[];
  fields: string[];
};
export const qualityRecordLimit = 2000;
const clinicalSources = (patient: QualityPatient, records: readonly ClinicalRecord[]) => {
  const source = records.filter(
    (row) =>
      row.patientClientId === patient.clientId &&
      !row.deleted &&
      row.payload &&
      row.payload.kind !== "qualityReview",
  );
  if (source.length > qualityRecordLimit) throw new Error("QUALITY_DATA_LIMIT");
  if (new Set(source.map((row) => row.clientId)).size !== source.length)
    throw new Error("INVALID_QUALITY_SOURCE");
  // Snapshot serialization must not depend on the browser/server locale.
  return source.toSorted((a, b) =>
    a.clientId === b.clientId ? 0 : a.clientId < b.clientId ? -1 : 1,
  );
};
export function qualitySourceSignature(
  patient: QualityPatient,
  records: readonly ClinicalRecord[],
  evaluationDate: string,
) {
  const source = clinicalSources(patient, records);
  return hash({
    version: "patient-quality-v1",
    evaluationDate,
    patient: {
      clientId: patient.clientId,
      revision: patient.revision,
      historyId: patient.historyId ?? null,
      fullName: patient.fullName,
      birthDate: patient.birthDate,
      sex: patient.sex,
      diagnosisCodes: patient.diagnosisCodes,
      notes: patient.notes,
    },
    records: source.map((row) => ({
      clientId: row.clientId,
      revision: row.revision,
      historyId: row.historyId ?? null,
      payload: row.payload,
    })),
  });
}
export function analyzePatientQuality(
  patient: QualityPatient,
  records: readonly ClinicalRecord[],
  evaluationDate: string,
) {
  if (patient.deleted) throw new Error("PATIENT_NOT_FOUND");
  z.iso.date().parse(evaluationDate);
  const source = clinicalSources(patient, records);
  const sourceSignature = qualitySourceSignature(patient, source, evaluationDate);
  const findings: QualityFinding[] = [];
  const add = (
    code: QualityFinding["code"],
    level: QualityFinding["level"],
    recordIds: string[] = [],
    fields: string[] = [],
  ) => {
    const ids = recordIds.toSorted();
    findings.push({
      key: `${code}:${hash({ patient: patient.clientId, ids })}`,
      code,
      level,
      recordIds: ids,
      fields,
    });
  };
  if (!patient.fullName.trim()) add("fullNameMissing", "documentation");
  if (!z.iso.date().safeParse(patient.birthDate).success) add("birthDateMissing", "documentation");
  if (patient.sex === "unknown") add("sexMissing", "documentation");
  if (!patient.diagnosisCodes.length) add("diagnosesUndocumented", "documentation");
  for (const [kind, code] of [
    ["history", "historyUndocumented"],
    ["allergy", "allergiesUndocumented"],
    ["medication", "medicationsUndocumented"],
    ["observation", "observationsUndocumented"],
  ] as const) {
    if (!source.some((row) => row.payload?.kind === kind)) add(code, "documentation");
  }
  const duplicates = new Map<string, string[]>();
  const normalize = (value: string) => value.trim().normalize("NFKC").toLowerCase();
  for (const row of source) {
    const value = row.payload!;
    if (z.iso.date().safeParse(patient.birthDate).success && value.occurredOn < patient.birthDate)
      add("dateBeforeBirth", "review", [row.clientId], ["occurredOn"]);
    if (value.kind === "medication") {
      if (value.status === "active" && value.endedOn && value.endedOn < evaluationDate)
        add("medicationEndUnconfirmed", "review", [row.clientId], ["status", "endedOn"]);
      if (value.status !== "active" && !value.endedOn)
        add("medicationEndMissing", "documentation", [row.clientId], ["endedOn"]);
    }
    if (value.kind === "visit" || value.kind === "studyVisit") {
      const utcDate = new Date(visitTime(value.scheduledFor).epoch).toISOString().slice(0, 10);
      if (value.status === "planned" && utcDate < evaluationDate)
        add("visitNeedsStatusUpdate", "followUp", [row.clientId], ["status", "scheduledFor"]);
      if (
        value.kind === "studyVisit" &&
        value.status === "planned" &&
        value.windowTo < evaluationDate
      )
        add("studyWindowPassed", "followUp", [row.clientId], ["windowTo", "status"]);
    }
    if (
      value.kind === "studyIssue" &&
      ["open", "underReview"].includes(value.status) &&
      value.reviewDueOn < evaluationDate
    )
      add("safetyReviewPastDue", "followUp", [row.clientId], ["reviewDueOn", "status"]);
    if (value.kind === "questionnaire") {
      const result = formAnswersSchema(value.definition, true).safeParse(value.answers);
      if (!result.success)
        add(
          "questionnaireNeedsCompletion",
          "documentation",
          [row.clientId],
          [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "answers")))],
        );
    }
    let duplicateKey: string | null = null;
    if (value.kind === "medication")
      duplicateKey = hash([
        value.kind,
        value.occurredOn,
        normalize(value.drug),
        value.code.trim(),
        value.dosage.trim(),
        value.route.trim(),
        value.status,
        value.endedOn,
      ]);
    if (value.kind === "allergy")
      duplicateKey = hash([
        value.kind,
        value.occurredOn,
        normalize(value.substance),
        normalize(value.reaction),
        value.severity,
        value.status,
      ]);
    if (value.kind === "observation")
      duplicateKey = hash([
        value.kind,
        value.occurredOn,
        normalize(value.name),
        value.code.trim(),
        value.numericValue,
        normalize(value.textValue),
        value.unit.trim(),
      ]);
    if (duplicateKey)
      duplicates.set(duplicateKey, [...(duplicates.get(duplicateKey) ?? []), row.clientId]);
  }
  for (const ids of duplicates.values())
    if (ids.length > 1) add("possibleDuplicate", "review", ids);
  return {
    algorithmVersion: "patient-quality-v1" as const,
    evaluationDate,
    sourceSignature,
    sourceCount: source.length,
    findings: findings.toSorted(
      (a, b) =>
        ({ followUp: 0, review: 1, documentation: 2 })[a.level] -
          { followUp: 0, review: 1, documentation: 2 }[b.level] ||
        a.code.localeCompare(b.code) ||
        a.key.localeCompare(b.key),
    ),
  };
}
export function validateQualityReview(
  value: QualityReviewPayload,
  patient: QualityPatient,
  records: readonly ClinicalRecord[],
  actor: string,
  today: string,
) {
  if (value.reviewedBy !== actor) throw new Error("ACCOUNT_CHANGED");
  if (value.evaluationDate > today || value.occurredOn > today)
    throw new Error("INVALID_CLINICAL_DATE");
  const report = analyzePatientQuality(patient, records, value.evaluationDate);
  if (report.sourceSignature !== value.sourceSignature) throw new Error("QUALITY_SOURCE_CHANGED");
  if (
    !report.findings.some(
      (finding) => finding.key === value.findingKey && finding.code === value.code,
    )
  )
    throw new Error("INVALID_QUALITY_REVIEW");
}
