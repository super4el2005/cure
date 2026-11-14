import { z } from "zod";

import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";

const claimsSchema = z.object({
  userId: z.string().min(1),
  purpose: z.literal("library"),
  expiresAt: z.number().finite().positive(),
});
const headerSchema = claimsSchema.extend({ salt: z.string().length(64), proof: z.string() });
export type LibraryLease = z.infer<typeof claimsSchema>;
const key = (userId: string) => `cure.library-vault.v1:${userId}`;
export function libraryHeader(userId: string, storage: Storage = window.localStorage) {
  const raw = storage.getItem(key(userId));
  if (!raw) return undefined;
  const header = headerSchema.parse(JSON.parse(raw));
  if (header.userId !== userId) throw new Error("INVALID_VAULT_DATA");
  return header;
}
export function persistLibraryHeader(
  header: z.infer<typeof headerSchema>,
  storage: Storage = window.localStorage,
) {
  storage.setItem(key(header.userId), JSON.stringify(headerSchema.parse(header)));
}
export async function prepareLibraryVault(
  input: { lease: LibraryLease; passphrase: string; onlineVerified: boolean },
  storage: Storage = window.localStorage,
) {
  const claims = claimsSchema.parse(input.lease);
  const previous = libraryHeader(claims.userId, storage);
  if (!input.onlineVerified && !previous) throw new Error("OFFLINE_NOT_PREPARED");
  if (claims.expiresAt <= Date.now()) throw new Error("OFFLINE_ACCESS_EXPIRED");
  if (!input.onlineVerified && previous?.expiresAt !== claims.expiresAt)
    throw new Error("INVALID_VAULT_DATA");
  const salt = previous?.salt ?? newVaultSalt();
  const vault = await unlockVault(input.passphrase, salt);
  try {
    if (previous) {
      const proof = claimsSchema.parse(vault.open(previous.proof, "cure-library-proof-v1"));
      if (JSON.stringify(proof) !== JSON.stringify(claimsSchema.parse(previous)))
        throw new Error("INVALID_VAULT_DATA");
    }
    return {
      vault,
      header: { ...claims, salt, proof: vault.seal(claims, "cure-library-proof-v1") },
    };
  } catch (error) {
    vault.lock();
    throw error;
  }
}
