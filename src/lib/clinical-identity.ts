import { createCollection, localStorageCollectionOptions } from "@tanstack/db";
import { z } from "zod";

import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/src/lib/auth-client";
import type { Vault } from "@/src/lib/patient-vault";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";

const identityOptions = (storage: Storage) =>
  localStorageCollectionOptions<{ id: string; userId: string; label: string }>({
    id: "cure-clinical-identity-v1",
    storageKey: "cure.clinical-identity.v1",
    storage,
    getKey: (row) => row.id,
  });
let identity: ReturnType<typeof createIdentity> | undefined;
function createIdentity(storage: Storage) {
  return createCollection(identityOptions(storage));
}
export function clinicalIdentity() {
  if (typeof window === "undefined") return undefined;
  return (identity ??= createIdentity(window.localStorage));
}
export async function rememberClinicalIdentity(userId: string, label: string) {
  const collection = clinicalIdentity();
  if (!collection) throw new Error("STORAGE_UNAVAILABLE");
  await collection.preload();
  const tx = collection.has("current")
    ? collection.update("current", (draft) => {
        draft.userId = userId;
        draft.label = label;
      })
    : collection.insert({ id: "current", userId, label });
  await tx.when("settled");
}
export async function lockClinicalAccess() {
  const collection = clinicalIdentity();
  if (collection) {
    await collection.preload();
    if (collection.has("current")) await collection.delete("current").when("settled");
  }
}
export async function signOutClinicalSession() {
  await lockClinicalAccess();
  return authClient.signOut();
}
const headerSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.enum(["doctor", "researcher"]),
  expiresAt: z.number(),
  salt: z.string(),
  proof: z.string(),
});
export type ClinicalHeader = z.infer<typeof headerSchema>;
export type ClinicalLease = {
  userId: string;
  organizationId: Id<"organizations">;
  role: "doctor" | "researcher";
  expiresAt: number;
};
const registryKey = "cure.clinical-vaults.v1";
export function clinicalHeaders(userId: string, storage: Storage = window.localStorage) {
  const raw = storage.getItem(registryKey);
  const headers = z.array(headerSchema).parse(raw ? JSON.parse(raw) : []);
  return headers.filter((h) => h.userId === userId);
}
function saveHeader(header: ClinicalHeader, storage: Storage = window.localStorage) {
  const raw = storage.getItem(registryKey);
  const headers = z.array(headerSchema).parse(raw ? JSON.parse(raw) : []);
  const remaining = headers.filter(
    (h) =>
      !(
        h.userId === header.userId &&
        h.organizationId === header.organizationId &&
        h.role === header.role
      ),
  );
  storage.setItem(registryKey, JSON.stringify([...remaining, header]));
}
export async function prepareClinicalVault(
  input: {
    lease: ClinicalLease;
    organizationName: string;
    passphrase: string;
    onlineVerified: boolean;
  },
  storage: Storage = window.localStorage,
): Promise<{ vault: Vault; header: ClinicalHeader }> {
  const existing = clinicalHeaders(input.lease.userId, storage).find(
    (h) => h.organizationId === input.lease.organizationId && h.role === input.lease.role,
  );
  if (existing && !input.onlineVerified && existing.expiresAt !== input.lease.expiresAt)
    throw new Error("INVALID_VAULT_DATA");
  if (!existing && !input.onlineVerified) throw new Error("OFFLINE_NOT_PREPARED");
  if (!input.onlineVerified && input.lease.expiresAt <= Date.now())
    throw new Error("OFFLINE_ACCESS_EXPIRED");
  const salt = existing?.salt ?? newVaultSalt();
  const vault = await unlockVault(input.passphrase, salt);
  try {
    if (existing) {
      const proof = headerSchema
        .omit({ proof: true, salt: true })
        .parse(vault.open(existing.proof, "cure-vault-proof-v1"));
      if (
        JSON.stringify(proof) !==
        JSON.stringify({
          userId: existing.userId,
          organizationId: existing.organizationId,
          organizationName: existing.organizationName,
          role: existing.role,
          expiresAt: existing.expiresAt,
        })
      )
        throw new Error("INVALID_VAULT_DATA");
    }
    const claims = { ...input.lease, organizationName: input.organizationName };
    const header = { ...claims, salt, proof: vault.seal(claims, "cure-vault-proof-v1") };
    return { vault, header };
  } catch (error) {
    vault.lock();
    throw error;
  }
}
export const persistClinicalHeader = saveHeader;
