import { describe, expect, it } from "@rstest/core";

import {
  libraryHeader,
  persistLibraryHeader,
  prepareLibraryVault,
} from "@/src/lib/library-identity";

describe("personal library vault claims", () => {
  it("authenticates actor, expiry and passphrase while preserving a global key across online renewal", async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
      clear: () => data.clear(),
      key: (index) => [...data.keys()][index] ?? null,
    };
    const lease = { userId: "doctor", purpose: "library" as const, expiresAt: Date.now() + 100000 };
    const input = { lease, passphrase: "private library passphrase", onlineVerified: true };
    await expect(prepareLibraryVault({ ...input, onlineVerified: false }, storage)).rejects.toThrow(
      "OFFLINE_NOT_PREPARED",
    );
    const first = await prepareLibraryVault(input, storage);
    persistLibraryHeader(first.header, storage);
    const ciphertext = first.vault.seal({ notes: "Private notes" }, "library-test");
    first.vault.lock();
    const offline = await prepareLibraryVault({ ...input, onlineVerified: false }, storage);
    expect(offline.vault.open(ciphertext, "library-test")).toEqual({ notes: "Private notes" });
    offline.vault.lock();
    await expect(
      prepareLibraryVault(
        { ...input, passphrase: "wrong private passphrase", onlineVerified: false },
        storage,
      ),
    ).rejects.toThrow("VAULT_UNLOCK_FAILED");
    await expect(
      prepareLibraryVault(
        { ...input, lease: { ...lease, expiresAt: lease.expiresAt + 1000 }, onlineVerified: false },
        storage,
      ),
    ).rejects.toThrow("INVALID_VAULT_DATA");
    const renewed = await prepareLibraryVault(
      { ...input, lease: { ...lease, expiresAt: lease.expiresAt + 1000 } },
      storage,
    );
    expect(renewed.header.salt).toBe(first.header.salt);
    expect(renewed.vault.open(ciphertext, "library-test")).toEqual({ notes: "Private notes" });
    renewed.vault.lock();
    persistLibraryHeader({ ...first.header, expiresAt: first.header.expiresAt + 1000 }, storage);
    await expect(
      prepareLibraryVault(
        { ...input, lease: { ...lease, expiresAt: lease.expiresAt + 1000 }, onlineVerified: false },
        storage,
      ),
    ).rejects.toThrow("INVALID_VAULT_DATA");
    expect(libraryHeader("other", storage)).toBeUndefined();
    expect(JSON.stringify([...data.values()])).not.toContain("Private notes");
    await expect(
      prepareLibraryVault(
        { ...input, lease: { ...lease, expiresAt: Date.now() - 1 }, onlineVerified: false },
        storage,
      ),
    ).rejects.toThrow("OFFLINE_ACCESS_EXPIRED");
  });
});
