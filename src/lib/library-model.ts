import { z } from "zod";

import type { PatientEnvelope } from "@/src/lib/patient-model";
import type { Vault } from "@/src/lib/patient-vault";

export const libraryEntrySchema = z
  .object({
    title: z.string().trim().min(1).max(1000),
    doi: z
      .string()
      .trim()
      .max(200)
      .refine((value) => !value || /^10\.\d{4,9}\/\S+$/i.test(value)),
    pmid: z
      .string()
      .regex(/^\d{1,12}$/)
      .or(z.literal("")),
    url: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .refine((value) => {
        try {
          const url = new URL(value);
          return !url.username && !url.password;
        } catch {
          return false;
        }
      })
      .or(z.literal("")),
    citation: z.string().trim().max(4000),
    authors: z.string().trim().max(2000),
    year: z.number().int().min(1500).max(2200).nullable(),
    collection: z.string().trim().max(200),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(20)
      .refine(
        (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      ),
    notes: z.string().trim().max(5000),
    status: z.enum(["toRead", "reading", "included", "excluded"]),
    exclusionReason: z.string().trim().max(1000),
    source: z.enum(["manual", "pubmed"]),
    fetchedAt: z.number().finite().nonnegative().nullable(),
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 60000)
  .refine((value) => value.status !== "excluded" || Boolean(value.exclusionReason), {
    path: ["exclusionReason"],
    message: "EXCLUSION_REASON_REQUIRED",
  });
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
export const libraryVersionSchema = z.object({
  confirmed: z.boolean().default(false),
  clientId: z.uuid(),
  itemClientId: z.uuid(),
  revision: z.number().int().positive(),
  entry: libraryEntrySchema,
  recordedAt: z.number().finite().positive(),
  recordedBy: z.string().min(1).max(200),
});
export type LibraryVersion = z.infer<typeof libraryVersionSchema>;
export const libraryRowSchema = z
  .object({
    clientId: z.uuid(),
    writeId: z.uuid(),
    revision: z.number().int().positive(),
    deleted: z.boolean(),
    entry: libraryEntrySchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .refine((row) => row.deleted === (row.entry === null));
export type LibraryRow = z.infer<typeof libraryRowSchema>;
export function sealLibrary(value: LibraryRow, vault: Vault, scope: string): PatientEnvelope {
  const row = libraryRowSchema.parse(value);
  return {
    clientId: row.clientId,
    revision: row.revision,
    deleted: row.deleted,
    ciphertext: vault.seal(row, `${scope}:${row.clientId}`),
  };
}
export function readLibrary(envelope: PatientEnvelope, vault: Vault, scope: string) {
  const row = libraryRowSchema.parse(
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
export type LibraryCommand = {
  clientId: string;
  expectedRevision: number;
  action: "create" | "update" | "delete";
  entry?: LibraryEntry;
};
export function sealLibraryVersion(
  value: z.input<typeof libraryVersionSchema>,
  vault: Vault,
  scope: string,
): PatientEnvelope {
  const row = libraryVersionSchema.parse(value);
  return {
    clientId: row.clientId,
    revision: row.revision,
    deleted: false,
    ciphertext: vault.seal(row, `${scope}:${row.clientId}`),
  };
}
export function readLibraryVersion(envelope: PatientEnvelope, vault: Vault, scope: string) {
  const row = libraryVersionSchema.parse(
    vault.open(envelope.ciphertext, `${scope}:${envelope.clientId}`),
  );
  if (row.clientId !== envelope.clientId || row.revision !== envelope.revision || envelope.deleted)
    throw new Error("INVALID_VAULT_DATA");
  return row;
}
