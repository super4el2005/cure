import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import type { StorageAdapter } from "@tanstack/offline-transactions";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export type Vault = Awaited<ReturnType<typeof unlockVault>>;

// The key lives only in this resource; it is never stored with the data.
export async function unlockVault(passphrase: string, salt: string) {
  if (passphrase.length < 12 || salt.length !== 64) throw new Error("INVALID_VAULT_PASSPHRASE");
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const key = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new Uint8Array(hexToBytes(salt)),
        iterations: 600000,
        hash: "SHA-256",
      },
      material,
      256,
    ),
  );
  let locked = false;
  function requireKey() {
    if (locked) throw new Error("VAULT_LOCKED");
  }
  return {
    seal(value: unknown, context: string): string {
      requireKey();
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = gcm(key, nonce, encoder.encode(context)).encrypt(
        encoder.encode(JSON.stringify(value)),
      );
      return `v1:${bytesToHex(nonce)}:${bytesToHex(ciphertext)}`;
    },
    open(value: string, context: string): unknown {
      requireKey();
      try {
        const [version, nonce, ciphertext, extra] = value.split(":");
        if (version !== "v1" || !nonce || !ciphertext || extra !== undefined) throw new Error();
        return JSON.parse(
          decoder.decode(
            gcm(key, hexToBytes(nonce), encoder.encode(context)).decrypt(hexToBytes(ciphertext)),
          ),
        );
      } catch {
        throw new Error("VAULT_UNLOCK_FAILED");
      }
    },
    lock() {
      locked = true;
      key.fill(0);
    },
  };
}
export function newVaultSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
export function encryptedStorage(
  storage: StorageAdapter,
  vault: Vault,
  scope: string,
): StorageAdapter {
  return {
    async get(key) {
      const value = await storage.get(key);
      if (value === null) return null;
      const decoded = vault.open(value, `${scope}:${key}`);
      if (typeof decoded !== "string") throw new Error("INVALID_VAULT_DATA");
      return decoded;
    },
    async set(key, value) {
      await storage.set(key, vault.seal(value, `${scope}:${key}`));
    },
    delete: (key) => storage.delete(key),
    keys: () => storage.keys(),
    clear: () => storage.clear(),
  };
}
