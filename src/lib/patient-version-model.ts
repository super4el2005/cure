import { z } from "zod";

import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientEnvelope } from "@/src/lib/patient-model";
import type { Vault } from "@/src/lib/patient-vault";

export const patientVersionValuesSchema = patientRowSchema.pick({
  fullName: true,
  birthDate: true,
  sex: true,
  diagnosisCodes: true,
  notes: true,
  consentHistory: true,
});
export const patientVersionSchema = z.object({
  clientId: z.string().min(1),
  patientClientId: z.uuid(),
  revision: z.number().int().positive(),
  values: patientVersionValuesSchema,
  recordedAt: z.number(),
  recordedBy: z.string(),
  confirmed: z.boolean().default(false),
});
export type PatientVersion = z.infer<typeof patientVersionSchema>;
export function legacyPatientVersionId(patientClientId: string, revision: number) {
  return `legacy-patient:${patientClientId}:${revision}`;
}
export function sealPatientVersion(
  row: PatientVersion,
  vault: Vault,
  scope: string,
): PatientEnvelope {
  const value = patientVersionSchema.parse(row);
  return {
    clientId: value.clientId,
    revision: value.revision,
    deleted: false,
    ciphertext: vault.seal(value, `${scope}:${value.clientId}`),
  };
}
export function openPatientVersion(row: PatientEnvelope, vault: Vault, scope: string) {
  const value = patientVersionSchema.parse(vault.open(row.ciphertext, `${scope}:${row.clientId}`));
  if (row.deleted || value.clientId !== row.clientId || value.revision !== row.revision)
    throw new Error("INVALID_VAULT_DATA");
  return value;
}
