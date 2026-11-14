import { z } from "zod";

import { clinicalPayloadSchema } from "@/src/lib/clinical-record-model";
import type { ClinicalEnvelope } from "@/src/lib/clinical-record-model";
import type { Vault } from "@/src/lib/patient-vault";

export const clinicalVersionSchema = z.object({
  clientId: z.string().min(1),
  recordClientId: z.uuid(),
  patientClientId: z.uuid(),
  revision: z.number().int().positive(),
  payload: clinicalPayloadSchema,
  recordedAt: z.number(),
  recordedBy: z.string(),
  confirmed: z.boolean().default(false),
});
export type ClinicalVersion = z.infer<typeof clinicalVersionSchema>;
export function sealClinicalVersion(
  row: ClinicalVersion,
  vault: Vault,
  scope: string,
): ClinicalEnvelope {
  const value = clinicalVersionSchema.parse(row);
  return {
    clientId: value.clientId,
    revision: value.revision,
    deleted: false,
    ciphertext: vault.seal(value, `${scope}:${value.clientId}`),
  };
}
export function openClinicalVersion(row: ClinicalEnvelope, vault: Vault, scope: string) {
  const value = clinicalVersionSchema.parse(vault.open(row.ciphertext, `${scope}:${row.clientId}`));
  if (row.deleted || value.clientId !== row.clientId || value.revision !== row.revision)
    throw new Error("INVALID_VAULT_DATA");
  return value;
}
export function legacyClinicalVersionId(recordClientId: string, revision: number) {
  return `legacy:${recordClientId}:${revision}`;
}
