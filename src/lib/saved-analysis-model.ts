import { z } from "zod";

import { cohortCriteriaSchema } from "@/src/lib/cohort-analysis";
import type { PatientEnvelope } from "@/src/lib/patient-model";
import type { Vault } from "@/src/lib/patient-vault";

export const analysisValuesSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  criteria: cohortCriteriaSchema,
});
export type AnalysisValues = z.infer<typeof analysisValuesSchema>;
export const savedAnalysisSchema = z
  .object({
    clientId: z.uuid(),
    revision: z.number().int().positive(),
    deleted: z.boolean(),
    values: analysisValuesSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .refine((row) => row.deleted === (row.values === null));
export type SavedAnalysis = z.infer<typeof savedAnalysisSchema>;
export function sealAnalysis(row: SavedAnalysis, vault: Vault, scope: string): PatientEnvelope {
  const value = savedAnalysisSchema.parse(row);
  return {
    clientId: value.clientId,
    revision: value.revision,
    deleted: value.deleted,
    ciphertext: vault.seal(value, `${scope}:${value.clientId}`),
  };
}
export function readAnalysis(envelope: PatientEnvelope, vault: Vault, scope: string) {
  const row = savedAnalysisSchema.parse(
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
export type AnalysisCommand = {
  clientId: string;
  expectedRevision: number;
  action: "create" | "update" | "delete";
  values?: AnalysisValues;
};
