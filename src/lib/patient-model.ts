import { z } from "zod";

import { consentEventSchema } from "@/src/lib/consent-model";
import type { Vault } from "@/src/lib/patient-vault";

export const patientValueSchema = z.object({
  consentHistory: z.array(consentEventSchema).default([]),
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.iso.date(),
  sex: z.enum(["female", "male", "unknown"]),
  diagnosisCodes: z.array(z.string().trim().min(1).max(50)).max(100),
  notes: z.string().max(20000),
});
export type PatientValues = z.input<typeof patientValueSchema>;
export const patientRowSchema = z.object({
  historyId: z.uuid().exactOptional(),
  updatedBy: z.string().exactOptional(),
  consentHistory: z.array(consentEventSchema).default([]),
  consentApproved: z.boolean().default(false),
  consentScope: z.array(z.enum(["sex", "diagnoses"])).default([]),
  clientId: z.uuid(),
  revision: z.number().int().positive(),
  deleted: z.boolean(),
  fullName: z.string(),
  birthDate: z.string(),
  sex: z.enum(["female", "male", "unknown"]),
  diagnosisCodes: z.array(z.string()),
  notes: z.string(),
  updatedAt: z.number(),
  accessExpiresAt: z.number().optional(),
});
export type PatientRow = z.infer<typeof patientRowSchema>;
export type PatientEnvelope = {
  clientId: string;
  revision: number;
  deleted: boolean;
  ciphertext: string;
};
export function patientEnvelope(
  row: z.input<typeof patientRowSchema>,
  vault: Vault,
  scope: string,
): PatientEnvelope {
  const value = patientRowSchema.parse(row);
  return {
    clientId: value.clientId,
    revision: value.revision,
    deleted: value.deleted,
    ciphertext: vault.seal(value, `${scope}:${value.clientId}`),
  };
}
export function openPatient(row: PatientEnvelope, vault: Vault, scope: string): PatientRow {
  const value = patientRowSchema.parse(vault.open(row.ciphertext, `${scope}:${row.clientId}`));
  if (
    value.clientId !== row.clientId ||
    value.revision !== row.revision ||
    value.deleted !== row.deleted
  )
    throw new Error("INVALID_VAULT_DATA");
  return value;
}

export const patientFormSchema = patientValueSchema.extend({
  diagnosisCodes: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean),
    )
    .pipe(patientValueSchema.shape.diagnosisCodes),
  clientId: z.string(),
  failureId: z.string(),
});
