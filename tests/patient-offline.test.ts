import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, rstest } from "@rstest/core";
import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence";
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence";
import type {
  LeaderElection,
  OnlineDetector,
  StorageAdapter,
} from "@tanstack/offline-transactions";
import { convexTest } from "convex-test";
import type { ConvexReactClient } from "convex/react";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { durabilityReceipts, openPatientWorkspace } from "@/src/lib/patient-workspace";
import { reportFailure } from "@/src/observability/events";

rstest.mock("@/src/observability/events", () => ({ reportFailure: rstest.fn() }));

function memoryStorage(): StorageAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async keys() {
      return [...values.keys()];
    },
    async clear() {
      values.clear();
    },
  };
}
function network() {
  let online = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(callback: () => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    notifyOnline() {
      for (const listener of listeners) listener();
    },
    isOnline() {
      return online;
    },
    dispose() {
      listeners.clear();
    },
    disconnect() {
      online = false;
      for (const listener of listeners) listener();
    },
    connect() {
      online = true;
      for (const listener of listeners) listener();
    },
  } satisfies OnlineDetector & { connect: () => void; disconnect: () => void };
}
function leader(): LeaderElection {
  return {
    async requestLeadership() {
      return true;
    },
    releaseLeadership() {},
    isLeader() {
      return true;
    },
    onLeadershipChange() {
      return () => {};
    },
  };
}
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};

describe("durable patient operations", () => {
  it("acknowledges local save only after durable storage completes and propagates quota errors", async () => {
    const storage = memoryStorage();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receipts = durabilityReceipts({
      ...storage,
      async set(key, value) {
        await blocked;
        await storage.set(key, value);
      },
    });
    let saved = false;
    const receipt = receipts.wait("operation").then(() => {
      saved = true;
    });
    const write = receipts.storage.set("tx:operation", JSON.stringify({ id: "operation" }));
    await Promise.resolve();
    expect(saved).toBe(false);
    release();
    await write;
    await receipt;
    expect(saved).toBe(true);
    const failed = durabilityReceipts({
      ...storage,
      async set() {
        throw new Error("quota");
      },
    });
    const pending = failed.wait("failed");
    const observed = expect(pending).rejects.toThrow("quota");
    await expect(failed.storage.set("tx:failed", JSON.stringify({ id: "failed" }))).rejects.toThrow(
      "quota",
    );
    await observed;
  });
  it("restores an encrypted pending operation after close and synchronizes it exactly once", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.mutation(internal.provisioning.createOrganization, {
      name: "Test clinic",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "doctor",
      organizationId,
      role: "doctor",
    });
    const doctor = t.withIdentity({ subject: "doctor" });
    let result: Awaited<ReturnType<typeof doctor.query<typeof api.patients.list>>> | undefined = [];
    const listeners = new Set<() => void>();
    let calls = 0;
    let clientFailure: unknown;
    const client = {
      watchQuery() {
        return {
          localQueryResult: () => result,
          onUpdate(callback: () => void) {
            listeners.add(callback);
            return () => {
              listeners.delete(callback);
            };
          },
        };
      },
      async mutation(
        _fn: unknown,
        args: Parameters<typeof doctor.mutation<typeof api.patients.apply>>[1],
      ) {
        calls++;
        const response = await doctor.mutation(api.patients.apply, args).catch((error) => {
          clientFailure = error;
          throw error;
        });
        result = await doctor.query(api.patients.list, { organizationId }).catch((error) => {
          clientFailure = error;
          throw error;
        });
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            clientFailure = error;
            throw error;
          }
        }
        return response;
      },
    } as unknown as ConvexReactClient;
    const sqlite = new DatabaseSync(":memory:");
    const database: BrowserWASQLiteDatabase = {
      async execute<T>(sql: string, params?: readonly unknown[]) {
        if (!params?.length && !/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) {
          sqlite.exec(sql);
          return [];
        }
        return sqlite
          .prepare(sql)
          .all(...((params ?? []) as (string | number | bigint | null | Uint8Array)[])) as T[];
      },
    };
    const storage = memoryStorage();
    const failures = memoryStorage();
    const salt = newVaultSalt();
    const passphrase = "a private offline workspace passphrase";
    const values = {
      fullName: "Private patient",
      birthDate: "1990-01-01",
      sex: "unknown" as const,
      diagnosisCodes: ["F41"],
      notes: "Private clinical notes",
    };
    const config = {
      client,
      userId: "doctor",
      organizationId,
      role: "doctor" as const,
      expiresAt: Date.now() + 60000,
      storage,
      failureStorage: failures,
      onAuthRequired() {},
    };
    const first = await openPatientWorkspace({
      ...config,
      persistence: createBrowserWASQLitePersistence({ database }),
      vault: await unlockVault(passphrase, salt),
      onlineDetector: network(),
      leaderElection: leader(),
    });
    await first.collection.preload();
    const saved = await first.save({
      action: "create",
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      values,
    });
    expect(calls).toBe(0);
    expect((await first.executor.peekOutbox()).length).toBe(1);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(values.fullName);
    await first.close();
    result = undefined;
    let nextNetwork = network();
    let restored = await openPatientWorkspace({
      ...config,
      persistence: createBrowserWASQLitePersistence({ database }),
      vault: await unlockVault(passphrase, salt),
      onlineDetector: nextNetwork,
      leaderElection: leader(),
    });
    const local = restored.collection.get("f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258");
    expect(local).toBeDefined();
    expect(restored.read(local!).fullName).toBe(values.fullName);
    const settled = restored.executor.waitForTransactionCompletion(saved.transactionId);
    result = [];
    nextNetwork.connect();
    restored.setAuthenticated(true);
    await settled.catch((error) => {
      throw (
        clientFailure ??
        rstest
          .mocked(reportFailure)
          .mock.calls.find((call) => call[2] === "PATIENT_SYNC_REJECTED")?.[0] ??
        restored.collection.utils.getSyncError() ??
        new Error(
          `Sync failed after ${calls} provider calls: ${error instanceof Error ? error.message : "unknown"}`,
        )
      );
    });
    expect(calls).toBe(1);
    expect(await doctor.query(api.patients.list, { organizationId })).toHaveLength(1);
    expect(await restored.executor.peekOutbox()).toEqual([]);
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "researcher",
      organizationId,
      role: "researcher",
    });
    nextNetwork.disconnect();
    restored.setAuthenticated(false);
    const event = {
      id: crypto.randomUUID(),
      version: 1,
      kind: "granted" as const,
      purpose: "Private study purpose",
      recipients: ["researcher"],
      scope: ["diagnoses" as const],
      documentReference: "Private consent document",
      expiresAt: Date.now() + 60000,
      recordedAt: Date.now(),
      recordedBy: "doctor",
    };
    const consentSaved = await restored.save({
      action: "consent",
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      consent: event,
    });
    expect(JSON.stringify([...storage.values.values()])).not.toContain(event.documentReference);
    await restored.close();
    result = undefined;
    nextNetwork = network();
    restored = await openPatientWorkspace({
      ...config,
      persistence: createBrowserWASQLitePersistence({ database }),
      vault: await unlockVault(passphrase, salt),
      onlineDetector: nextNetwork,
      leaderElection: leader(),
    });
    expect(
      restored.read(restored.collection.get("f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258")!)
        .consentHistory,
    ).toEqual([event]);
    const consentSettled = restored.executor.waitForTransactionCompletion(
      consentSaved.transactionId,
    );
    result = await doctor.query(api.patients.list, { organizationId });
    nextNetwork.connect();
    restored.setAuthenticated(true);
    await consentSettled;
    expect((await doctor.query(api.patients.list, { organizationId }))[0]?.consentHistory).toEqual([
      event,
    ]);
    nextNetwork.disconnect();
    restored.setAuthenticated(false);
    const conflict = await restored.save({
      action: "update",
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      values: { ...values, notes: "Unsent local note" },
    });
    await doctor.mutation(api.patients.apply, {
      actorId: "doctor",
      organizationId,
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      action: "update",
      expectedRevision: 2,
      idempotencyKey: "another-tab-edit",
      values: { ...values, notes: "Newer server note" },
    });
    const rejected = expect(
      restored.executor.waitForTransactionCompletion(conflict.transactionId),
    ).rejects.toThrow("REVISION_CONFLICT");
    result = await doctor.query(api.patients.list, { organizationId });
    for (const listener of listeners) listener();
    await restored.collection.utils.awaitSync();
    nextNetwork.connect();
    restored.setAuthenticated(true);
    await rejected;
    const archived = await restored.failedActions();
    expect(archived).toHaveLength(1);
    expect(archived[0]?.code).toBe("REVISION_CONFLICT");
    expect(restored.read(archived[0]!.envelope).notes).toBe("Unsent local note");
    expect((await doctor.query(api.patients.list, { organizationId }))[0]?.notes).toBe(
      "Newer server note",
    );
    expect(JSON.stringify([...failures.values.values()])).not.toContain("Unsent local note");
    nextNetwork.disconnect();
    restored.setAuthenticated(false);
    const rejectedEvent = {
      ...event,
      id: crypto.randomUUID(),
      version: 2,
      recipients: ["not-approved"],
      purpose: "Pending consent purpose",
    };
    const consentRejected = await restored.save({
      action: "consent",
      clientId: "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258",
      consent: rejectedEvent,
    });
    const consentFailure = expect(
      restored.executor.waitForTransactionCompletion(consentRejected.transactionId),
    ).rejects.toThrow("INVALID_CONSENT_RECIPIENT");
    nextNetwork.connect();
    restored.setAuthenticated(true);
    await consentFailure;
    const preservedConsent = (await restored.failedActions()).find(
      (item) => item.id !== archived[0]!.id,
    );
    expect(preservedConsent?.consentId).toBe(rejectedEvent.id);
    const restoredEvent = restored
      .read(preservedConsent!.envelope)
      .consentHistory.find((item) => item.id === preservedConsent!.consentId);
    expect(restoredEvent).toEqual(rejectedEvent);
    expect(restoredEvent?.expiresAt).toBe(event.expiresAt);
    expect(JSON.stringify([...failures.values.values()])).not.toContain(rejectedEvent.purpose);
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const rows = sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      expect(JSON.stringify(rows)).not.toContain(values.fullName);
      expect(JSON.stringify(rows)).not.toContain(values.notes);
    }
    await restored.close();
    sqlite.close();
  });
});
