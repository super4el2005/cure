import { describe, expect, it } from "@rstest/core";

import { clinicalPayloadSchema, clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { qualityReviewPayloadSchema, qualitySourceKinds } from "@/src/lib/data-quality-model";
import {
  analyzePatientQuality,
  qualityRecordLimit,
  validateQualityReview,
} from "@/src/lib/patient-data-quality";
import { patientRowSchema } from "@/src/lib/patient-model";

const patient = patientRowSchema.parse({
  clientId: crypto.randomUUID(),
  revision: 1,
  deleted: false,
  fullName: "Private patient",
  birthDate: "1990-01-01",
  sex: "unknown",
  diagnosisCodes: [],
  notes: "Private patient note",
  updatedAt: 1,
});
const day = "2026-11-14";
const row = (payload: ClinicalPayload) =>
  clinicalRecordSchema.parse({
    clientId: crypto.randomUUID(),
    patientClientId: patient.clientId,
    revision: 1,
    deleted: false,
    payload,
    createdAt: 1,
    updatedAt: 1,
  });
const medication = (extra: Partial<Extract<ClinicalPayload, { kind: "medication" }>> = {}) =>
  row({
    kind: "medication",
    occurredOn: "2020-01-01",
    notes: "",
    drug: "Recorded drug",
    code: "",
    dosage: "Recorded dose",
    route: "",
    endedOn: "",
    status: "active",
    ...extra,
  });
function review(records: ReturnType<typeof row>[] = []) {
  const report = analyzePatientQuality(patient, records, day);
  const finding = report.findings.find((finding) => finding.code === "allergiesUndocumented")!;
  return qualityReviewPayloadSchema.parse({
    kind: "qualityReview",
    writeId: crypto.randomUUID(),
    occurredOn: day,
    notes: "Private review note",
    algorithmVersion: "patient-quality-v1",
    evaluationDate: day,
    sourceSignature: report.sourceSignature,
    findingKey: finding.key,
    code: finding.code,
    decision: "reviewedAsRecorded",
    reviewedBy: "doctor",
  });
}
describe("patient documentation quality rules", () => {
  it("reports undocumented categories without a clinical completeness score or claiming disease absence", () => {
    const report = analyzePatientQuality(patient, [], day);
    expect(report.findings.map((finding) => finding.code).sort()).toEqual(
      [
        "sexMissing",
        "diagnosesUndocumented",
        "historyUndocumented",
        "allergiesUndocumented",
        "medicationsUndocumented",
        "observationsUndocumented",
      ].sort(),
    );
    expect(report.findings.every((finding) => finding.level === "documentation")).toBe(true);
    expect(report).not.toHaveProperty("score");
  });
  it("covers every current clinical kind in the authoritative source query except review notes", () => {
    expect(new Set(qualitySourceKinds)).toEqual(
      new Set(
        clinicalPayloadSchema.options
          .map((option) => option.shape.kind.value)
          .filter((kind) => kind !== "qualityReview"),
      ),
    );
  });
  it("flags dates needing context and unfinished medication dates without changing treatment", () => {
    const rows = [
      medication({ occurredOn: "1989-01-01", endedOn: "2026-11-13" }),
      medication({ status: "stopped" }),
    ];
    const before = JSON.stringify(rows);
    const findings = analyzePatientQuality(patient, rows, day).findings;
    expect(findings.some((finding) => finding.code === "dateBeforeBirth")).toBe(true);
    expect(findings.some((finding) => finding.code === "medicationEndUnconfirmed")).toBe(true);
    expect(findings.some((finding) => finding.code === "medicationEndMissing")).toBe(true);
    expect(
      analyzePatientQuality(patient, [medication({ endedOn: day })], day).findings.some(
        (finding) => finding.code === "medicationEndUnconfirmed",
      ),
    ).toBe(false);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("uses the UTC control day for planned visit status and does not declare nonattendance", () => {
    const visit = row({
      kind: "visit",
      occurredOn: "2026-11-14",
      scheduledFor: "2026-11-14T00:30:00+14:00[Pacific/Kiritimati]",
      durationMinutes: 30,
      visitType: "procedure",
      status: "planned",
      reason: "Recorded reason",
      location: "",
      outcome: "",
      followUpOn: "",
      cancellationReason: "",
      notes: "",
    });
    expect(
      analyzePatientQuality(patient, [visit], day).findings.some(
        (finding) => finding.code === "visitNeedsStatusUpdate",
      ),
    ).toBe(true);
    expect(visit.payload?.kind === "visit" ? visit.payload.status : null).toBe("planned");
  });
  it("validates required active questionnaire fields using the template while preserving zero and false", () => {
    const number = crypto.randomUUID(),
      boolean = crypto.randomUUID(),
      hidden = crypto.randomUUID();
    const definition = {
      title: "Template",
      description: "",
      fields: [
        {
          id: number,
          type: "number" as const,
          label: "Number",
          help: "",
          required: true,
          minimum: null,
          maximum: null,
          unit: "",
        },
        { id: boolean, type: "boolean" as const, label: "Boolean", help: "", required: true },
        {
          id: hidden,
          type: "text" as const,
          label: "Hidden",
          help: "",
          required: true,
          maxLength: 100,
          visibleWhen: {
            mode: "all" as const,
            rules: [{ fieldId: boolean, operator: "equals" as const, value: true }],
          },
        },
      ],
    };
    const payload = {
      kind: "questionnaire" as const,
      writeId: crypto.randomUUID(),
      occurredOn: "2020-01-01",
      notes: "",
      projectClientId: crypto.randomUUID(),
      formVersionClientId: crypto.randomUUID(),
      formClientId: crypto.randomUUID(),
      formVersion: 1,
      definition,
      answers: { [number]: 0, [boolean]: false },
      status: "draft" as const,
      amendmentReason: "",
    };
    expect(
      analyzePatientQuality(patient, [row(payload)], day).findings.some(
        (finding) => finding.code === "questionnaireNeedsCompletion",
      ),
    ).toBe(false);
    const result = analyzePatientQuality(
      patient,
      [row({ ...payload, answers: { [boolean]: false } })],
      day,
    );
    expect(
      result.findings.find((finding) => finding.code === "questionnaireNeedsCompletion")?.fields,
    ).toContain(number);
  });
  it("groups possible duplicate structured records without deleting or merging them", () => {
    const rows = [medication(), medication({ notes: "Different context" })];
    const finding = analyzePatientQuality(patient, rows, day).findings.find(
      (finding) => finding.code === "possibleDuplicate",
    );
    expect(finding?.recordIds).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });
  it("binds reviews to the complete current source, disregards delivery timestamps and excludes review notes", () => {
    const records = [medication(), medication({ drug: "Another recorded drug" })];
    const value = review(records);
    expect(() => validateQualityReview(value, patient, records, "doctor", day)).not.toThrow();
    expect(() =>
      validateQualityReview(value, patient, records.toReversed(), "doctor", day),
    ).not.toThrow();
    expect(() =>
      validateQualityReview(
        value,
        patient,
        records.map((record, index) =>
          index === 0 ? { ...record, revision: record.revision + 1 } : record,
        ),
        "doctor",
        day,
      ),
    ).toThrow("QUALITY_SOURCE_CHANGED");
    expect(() =>
      validateQualityReview(
        value,
        patient,
        records.map((record, index) =>
          index === 0 ? { ...record, historyId: crypto.randomUUID() } : record,
        ),
        "doctor",
        day,
      ),
    ).toThrow("QUALITY_SOURCE_CHANGED");
    expect(
      analyzePatientQuality(
        patient,
        records.map((row) => ({ ...row, updatedAt: 999, createdAt: 999 })),
        day,
      ).sourceSignature,
    ).toBe(value.sourceSignature);
    expect(analyzePatientQuality(patient, [...records, row(value)], day).sourceSignature).toBe(
      value.sourceSignature,
    );
    expect(() =>
      validateQualityReview(
        value,
        { ...patient, notes: "Changed patient note" },
        records,
        "doctor",
        day,
      ),
    ).toThrow("QUALITY_SOURCE_CHANGED");
    expect(() => validateQualityReview(value, patient, [], "doctor", day)).toThrow(
      "QUALITY_SOURCE_CHANGED",
    );
  });
  it("rejects forged findings, actors and future control dates and handles historical control days honestly", () => {
    const value = review();
    expect(() =>
      validateQualityReview({ ...value, findingKey: "invented" }, patient, [], "doctor", day),
    ).toThrow("INVALID_QUALITY_REVIEW");
    expect(() => validateQualityReview(value, patient, [], "researcher", day)).toThrow(
      "ACCOUNT_CHANGED",
    );
    expect(() => validateQualityReview(value, patient, [], "doctor", "2026-11-13")).toThrow(
      "INVALID_CLINICAL_DATE",
    );
    expect(() => validateQualityReview(value, patient, [], "doctor", "2026-11-15")).not.toThrow();
    expect(analyzePatientQuality(patient, [], day).sourceSignature).not.toBe(
      analyzePatientQuality(patient, [], "2026-11-15").sourceSignature,
    );
  });
  it("ignores other patients and tombstones and refuses duplicate identities or an oversized source", () => {
    const value = medication();
    const report = analyzePatientQuality(
      patient,
      [
        { ...value, patientClientId: crypto.randomUUID() },
        { ...value, deleted: true, payload: null },
      ],
      day,
    );
    expect(report.sourceCount).toBe(0);
    expect(() => analyzePatientQuality(patient, [value, value], day)).toThrow(
      "INVALID_QUALITY_SOURCE",
    );
    expect(() =>
      analyzePatientQuality(
        patient,
        Array.from({ length: qualityRecordLimit + 1 }, () => medication()),
        day,
      ),
    ).toThrow("QUALITY_DATA_LIMIT");
    expect(() => analyzePatientQuality({ ...patient, deleted: true }, [], day)).toThrow(
      "PATIENT_NOT_FOUND",
    );
  });
  it("uses explicit study windows and safety review deadlines without recording a violation", () => {
    const source = row({
      kind: "studyVisit",
      writeId: crypto.randomUUID(),
      enrollmentClientId: crypto.randomUUID(),
      enrollmentWriteId: crypto.randomUUID(),
      projectClientId: crypto.randomUUID(),
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      occurredOn: "2020-01-02",
      notes: "",
      scheduledFor: "2020-01-02T12:00:00+00:00[UTC]",
      durationMinutes: 30,
      visitType: "consultation",
      status: "planned",
      reason: "Visit",
      location: "",
      outcome: "",
      followUpOn: "",
      cancellationReason: "",
      windowFrom: "2020-01-01",
      windowTo: "2020-01-03",
      performedOn: "",
      deviationReason: "",
      amendmentReason: "",
    });
    expect(
      analyzePatientQuality(patient, [source], day).findings.some(
        (finding) => finding.code === "studyWindowPassed",
      ),
    ).toBe(true);
    const safety = row({
      kind: "studyIssue",
      writeId: crypto.randomUUID(),
      projectClientId: crypto.randomUUID(),
      enrollmentClientId: crypto.randomUUID(),
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      occurredOn: "2020-01-01",
      detectedOn: "2020-01-02",
      title: "Issue",
      description: "Description",
      notes: "",
      status: "open",
      reviewerId: "doctor",
      reviewDueOn: "2020-01-03",
      resolution: "",
      reviewedOn: "",
      reviewedBy: "",
      amendmentReason: "",
      details: {
        type: "deviation",
        impact: "minor",
        protocolSection: "1",
        rootCause: "",
        correctiveAction: "",
        preventiveAction: "",
      },
    });
    expect(
      analyzePatientQuality(patient, [safety], day).findings.some(
        (finding) => finding.code === "safetyReviewPastDue",
      ),
    ).toBe(true);
    expect(safety.payload?.kind === "studyIssue" ? safety.payload.status : "").toBe("open");
  });
  it("preserves case-sensitive measurement units when proposing duplicate records", () => {
    const first = row({
      kind: "observation",
      occurredOn: "2020-01-01",
      notes: "",
      name: "Length",
      code: "",
      numericValue: 1,
      textValue: "",
      unit: "mm",
    });
    const second = row({
      ...(first.payload as Extract<ClinicalPayload, { kind: "observation" }>),
      unit: "Mm",
    });
    expect(
      analyzePatientQuality(patient, [first, second], day).findings.some(
        (finding) => finding.code === "possibleDuplicate",
      ),
    ).toBe(false);
  });
});
