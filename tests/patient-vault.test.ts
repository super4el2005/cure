import { describe, expect, it } from "@rstest/core";
import type { StorageAdapter } from "@tanstack/offline-transactions";

import { openPatient, patientEnvelope } from "@/src/lib/patient-model";
import { encryptedStorage, newVaultSalt, unlockVault } from "@/src/lib/patient-vault";

describe("encrypted offline patient data", () => {
  it("restores encrypted rows after reopening but refuses another workspace, tampering and locked access", async () => {
    const salt = newVaultSalt();
    const vault = await unlockVault("a sufficiently long passphrase", salt);
    const row = {
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      revision: 1,
      deleted: false,
      fullName: "Private Patient",
      birthDate: "1990-01-01",
      sex: "unknown" as const,
      diagnosisCodes: ["F41"],
      notes: "Private notes",
      updatedAt: Date.now(),
    };
    const envelope = patientEnvelope(row, vault, "doctor:clinic");
    expect(JSON.stringify(envelope)).not.toContain(row.fullName);
    expect(JSON.stringify(envelope)).not.toContain(row.notes);
    expect(() => openPatient(envelope, vault, "other:clinic")).toThrow("VAULT_UNLOCK_FAILED");
    expect(() => openPatient({ ...envelope, revision: 10 }, vault, "doctor:clinic")).toThrow(
      "INVALID_VAULT_DATA",
    );
    vault.lock();
    expect(() => openPatient(envelope, vault, "doctor:clinic")).toThrow("VAULT_LOCKED");
    const restored = await unlockVault("a sufficiently long passphrase", salt);
    expect(openPatient(envelope, restored, "doctor:clinic")).toEqual({
      ...row,
      consentHistory: [],
      consentApproved: false,
      consentScope: [],
    });
    const wrong = await unlockVault("a different long passphrase", salt);
    expect(() => openPatient(envelope, wrong, "doctor:clinic")).toThrow("VAULT_UNLOCK_FAILED");
    wrong.lock();
    restored.lock();
  });
  it("encrypts the complete outbox record including errors and metadata", async () => {
    const map = new Map<string, string>();
    const underlying: StorageAdapter = {
      async get(k) {
        return map.get(k) ?? null;
      },
      async set(k, v) {
        map.set(k, v);
      },
      async delete(k) {
        map.delete(k);
      },
      async keys() {
        return [...map.keys()];
      },
      async clear() {
        map.clear();
      },
    };
    const vault = await unlockVault("another sufficiently long passphrase", newVaultSalt());
    const storage = encryptedStorage(underlying, vault, "owner:clinic");
    const serialized = JSON.stringify({
      id: "mutation-1",
      notes: "Private notes",
      lastError: "Private error",
    });
    await storage.set("tx:mutation-1", serialized);
    expect(JSON.stringify([...map.values()])).not.toContain("Private");
    expect(await storage.get("tx:mutation-1")).toBe(serialized);
    expect(await storage.get("missing")).toBeNull();
    map.set("tx:copied", map.get("tx:mutation-1")!);
    await expect(storage.get("tx:copied")).rejects.toThrow("VAULT_UNLOCK_FAILED");
    vault.lock();
  });
});
