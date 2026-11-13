import { z } from "zod";

import type { Vault } from "@/src/lib/patient-vault";

const common = { occurredOn: z.iso.date(), notes: z.string().trim().max(2000) };
export const clinicalPayloadSchema = z
  .discriminatedUnion("kind", [
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
export const clinicalRecordSchema = z
  .object({
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
  action: "create" | "update" | "delete";
  payload?: ClinicalPayload;
};
