import { z } from "zod";

import type { Vault } from "@/src/lib/patient-vault";
import { enrollmentPayloadSchema } from "@/src/lib/study-enrollment-model";
import { formDefinitionSchema, questionnairePayloadSchema } from "@/src/lib/study-form-model";
import { studyIssuePayloadSchema } from "@/src/lib/study-issue-model";
import { studyVisitPayloadSchema, visitFields } from "@/src/lib/study-visit-model";
import { visitTime, visitTimeSchema } from "@/src/lib/visit-time";

const common = { occurredOn: z.iso.date(), notes: z.string().trim().max(2000) };
export const clinicalPayloadSchema = z
  .discriminatedUnion("kind", [
    questionnairePayloadSchema,
    enrollmentPayloadSchema,
    studyVisitPayloadSchema,
    studyIssuePayloadSchema,
    z.object({ ...visitFields, kind: z.literal("visit") }),
    z.object({ ...common, kind: z.literal("history"), text: z.string().trim().min(1).max(10000) }),
    z.object({
      ...common,
      kind: z.literal("allergy"),
      substance: z.string().trim().min(1).max(200),
      reaction: z.string().trim().min(1).max(1000),
      severity: z.enum(["unknown", "mild", "moderate", "severe"]),
      status: z.enum(["active", "inactive"]),
    }),
    z.object({
      ...common,
      kind: z.literal("medication"),
      drug: z.string().trim().min(1).max(200),
      code: z.string().trim().max(100),
      dosage: z.string().trim().min(1).max(200),
      route: z.string().trim().max(100),
      endedOn: z.union([z.literal(""), z.iso.date()]),
      status: z.enum(["active", "completed", "stopped"]),
    }),
    z.object({
      ...common,
      kind: z.literal("observation"),
      name: z.string().trim().min(1).max(200),
      code: z.string().trim().max(100),
      numericValue: z.number().finite().nullable(),
      textValue: z.string().trim().max(1000),
      unit: z.string().trim().max(100),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind === "visit" || value.kind === "studyVisit") {
      if (
        visitTimeSchema.safeParse(value.scheduledFor).success &&
        visitTime(value.scheduledFor).date !== value.occurredOn
      )
        ctx.addIssue({ code: "custom", path: ["scheduledFor"], message: "INVALID_VISIT_TIME" });
      if (value.status === "completed" && !value.outcome)
        ctx.addIssue({ code: "custom", path: ["outcome"], message: "VISIT_OUTCOME_REQUIRED" });
      if (value.status === "cancelled" && !value.cancellationReason)
        ctx.addIssue({
          code: "custom",
          path: ["cancellationReason"],
          message: "VISIT_CANCELLATION_REQUIRED",
        });
      if (value.followUpOn && value.followUpOn < value.occurredOn)
        ctx.addIssue({ code: "custom", path: ["followUpOn"], message: "INVALID_CLINICAL_DATE" });
    }
    if (value.kind === "medication" && value.endedOn && value.endedOn < value.occurredOn)
      ctx.addIssue({ code: "custom", path: ["endedOn"], message: "INVALID_CLINICAL_DATE" });
    if (
      value.kind === "observation" &&
      (value.numericValue === null ? !value.textValue : Boolean(value.textValue))
    )
      ctx.addIssue({
        code: "custom",
        path: ["numericValue"],
        message: "INVALID_OBSERVATION_VALUE",
      });
  });
export type ClinicalPayload = z.infer<typeof clinicalPayloadSchema>;
export type VisitPayload = Extract<ClinicalPayload, { kind: "visit" }>;
export const visitTransitions: Record<VisitPayload["status"], readonly VisitPayload["status"][]> = {
  planned: ["planned", "inProgress", "completed", "cancelled", "noShow"],
  inProgress: ["inProgress", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
  noShow: ["noShow"],
};
export function validateClinicalTransition(previous: ClinicalPayload, next: ClinicalPayload) {
  if (previous.kind !== next.kind) throw new Error("CLINICAL_KIND_IMMUTABLE");
  if (previous.kind === "questionnaire" && next.kind === "questionnaire") {
    if (
      previous.formVersionClientId !== next.formVersionClientId ||
      previous.formClientId !== next.formClientId ||
      previous.formVersion !== next.formVersion ||
      previous.projectClientId !== next.projectClientId ||
      JSON.stringify(formDefinitionSchema.parse(previous.definition)) !==
        JSON.stringify(formDefinitionSchema.parse(next.definition))
    )
      throw new Error("FORM_VERSION_IMMUTABLE");
    if (previous.status === "final") {
      if (next.status !== "final") throw new Error("FINAL_ANSWER_IMMUTABLE");
      const original = previous.definition.fields.map((field) => [
        field.id,
        previous.answers[field.id] ?? null,
      ]);
      const modified = next.definition.fields.map((field) => [
        field.id,
        next.answers[field.id] ?? null,
      ]);
      if (
        (JSON.stringify(original) !== JSON.stringify(modified) ||
          previous.occurredOn !== next.occurredOn ||
          previous.notes !== next.notes) &&
        !next.amendmentReason
      )
        throw new Error("AMENDMENT_REASON_REQUIRED");
    }
  }
  if (previous.kind === "studyVisit" && next.kind === "studyVisit") {
    if (
      previous.enrollmentClientId !== next.enrollmentClientId ||
      previous.projectClientId !== next.projectClientId ||
      previous.protocolClientId !== next.protocolClientId ||
      previous.protocolVersion !== next.protocolVersion
    )
      throw new Error("STUDY_VISIT_BINDING_IMMUTABLE");
    if (["completed", "cancelled", "noShow"].includes(previous.status) && !next.amendmentReason)
      throw new Error("AMENDMENT_REASON_REQUIRED");
    if (
      ["completed", "cancelled", "noShow"].includes(previous.status) &&
      (previous.windowFrom !== next.windowFrom || previous.windowTo !== next.windowTo)
    )
      throw new Error("VISIT_SCHEDULE_IMMUTABLE");
  }
  if (
    (previous.kind === "visit" || previous.kind === "studyVisit") &&
    (next.kind === "visit" || next.kind === "studyVisit")
  ) {
    if (!visitTransitions[previous.status].includes(next.status))
      throw new Error("INVALID_VISIT_TRANSITION");
    if (
      ["completed", "cancelled", "noShow"].includes(previous.status) &&
      (previous.scheduledFor !== next.scheduledFor ||
        previous.durationMinutes !== next.durationMinutes)
    )
      throw new Error("VISIT_SCHEDULE_IMMUTABLE");
  }
}
export const clinicalRecordSchema = z
  .object({
    historyId: z.uuid().exactOptional(),
    updatedBy: z.string().exactOptional(),
    clientId: z.uuid(),
    patientClientId: z.uuid(),
    revision: z.number().int().positive(),
    deleted: z.boolean(),
    payload: clinicalPayloadSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .refine((row) => row.deleted === (row.payload === null));
export type ClinicalRecord = z.infer<typeof clinicalRecordSchema>;
export type ClinicalEnvelope = {
  clientId: string;
  revision: number;
  deleted: boolean;
  ciphertext: string;
};
export function clinicalEnvelope(
  row: ClinicalRecord,
  vault: Vault,
  scope: string,
): ClinicalEnvelope {
  const value = clinicalRecordSchema.parse(row);
  return {
    clientId: value.clientId,
    revision: value.revision,
    deleted: value.deleted,
    ciphertext: vault.seal(value, `${scope}:${value.clientId}`),
  };
}
export function openClinicalRecord(envelope: ClinicalEnvelope, vault: Vault, scope: string) {
  const row = clinicalRecordSchema.parse(
    vault.open(envelope.ciphertext, `${scope}:${envelope.clientId}`),
  );
  if (
    row.clientId !== envelope.clientId ||
    row.revision !== envelope.revision ||
    row.deleted !== envelope.deleted
  )
    throw new Error("INVALID_VAULT_DATA");
  return row;
}
export type ClinicalCommand = {
  clientId: string;
  patientClientId: string;
  expectedRevision: number;
  expectedHistoryId?: string | null;
  action: "create" | "update" | "delete";
  payload?: ClinicalPayload;
};

export function hasClinicalWriteId(
  value: ClinicalPayload | null | undefined,
): value is Extract<ClinicalPayload, { writeId: string }> {
  return Boolean(value && "writeId" in value);
}
