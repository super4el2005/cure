import { describe, expect, it } from "@rstest/core";

import type { Id } from "@/convex/_generated/dataModel";
import {
  clinicalHeaders,
  persistClinicalHeader,
  prepareClinicalVault,
} from "@/src/lib/clinical-identity";

describe("bounded offline access", () => {
  it("requires initial preparation and authenticates cached identity, organization, role and expiry", async () => {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      getItem: (key) => data.get(key) ?? null,
      setItem(key, value) {
        data.set(key, value);
      },
      removeItem(key) {
        data.delete(key);
      },
      clear() {
        data.clear();
      },
      key: (index) => [...data.keys()][index] ?? null,
    };
    const lease = {
      userId: "doctor",
      organizationId: "clinic" as Id<"organizations">,
      role: "doctor" as const,
      expiresAt: Date.now() + 10000,
    };
    const input = {
      lease,
      organizationName: "Clinic",
      passphrase: "a sufficiently long local passphrase",
      onlineVerified: false,
    };
    await expect(prepareClinicalVault(input, storage)).rejects.toThrow("OFFLINE_NOT_PREPARED");
    const prepared = await prepareClinicalVault({ ...input, onlineVerified: true }, storage);
    persistClinicalHeader(prepared.header, storage);
    prepared.vault.lock();
    expect(clinicalHeaders("someone-else", storage)).toEqual([]);
    const unlocked = await prepareClinicalVault(input, storage);
    unlocked.vault.lock();
    await expect(
      prepareClinicalVault(
        { ...input, lease: { ...lease, expiresAt: lease.expiresAt + 10000 } },
        storage,
      ),
    ).rejects.toThrow("INVALID_VAULT_DATA");
    const entry = [...data.entries()][0]!;
    const headers = JSON.parse(entry[1]);
    headers[0].expiresAt += 10000;
    storage.setItem(entry[0], JSON.stringify(headers));
    await expect(
      prepareClinicalVault(
        { ...input, lease: { ...lease, expiresAt: headers[0].expiresAt } },
        storage,
      ),
    ).rejects.toThrow("INVALID_VAULT_DATA");
  });
});
