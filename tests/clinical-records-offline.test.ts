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
import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
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
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
it.each(["history", "visit"] as const)(
  "restores the empty snapshot and encrypted %s create/update/delete queue",
  async (kind) => {
    const t = convexTest(schema, modules);
    const organizationId = await t.mutation(internal.provisioning.createOrganization, {
      name: "Clinic",
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
    const patientClientId = crypto.randomUUID();
    await doctor.mutation(api.patients.apply, {
      actorId: "doctor",
      organizationId,
      clientId: patientClientId,
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "patient",
      values: {
        fullName: "Private patient",
        birthDate: "1990-01-01",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
      },
    });
    let snapshots = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    const refresh = async () => {
      for (const fn of [api.patients.list, api.clinicalRecords.list])
        snapshots.set(
          getFunctionName(fn),
          await doctor.query(fn, { actorId: "doctor", organizationId }),
        );
      for (const listener of listeners) listener();
    };
    await refresh();
    let calls = 0;
    const client = {
      watchQuery(fn: FunctionReference<"query">) {
        return {
          localQueryResult: () => snapshots.get(getFunctionName(fn)),
          onUpdate(cb: () => void) {
            listeners.add(cb);
            return () => {
              listeners.delete(cb);
            };
          },
        };
      },
      async mutation(fn: FunctionReference<"mutation">, args: Record<string, Value>) {
        calls++;
        const result = await doctor.mutation(fn, args);
        await refresh();
        return result;
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
    const failureStorage = memoryStorage();
    const metadataStorage = memoryStorage();
    const salt = newVaultSalt();
    let connection = network();
    const open = async () => {
      connection = network();
      const space = await openPatientWorkspace({
        client,
        userId: "doctor",
        organizationId,
        role: "doctor",
        expiresAt: Date.now() + 60000,
        storage,
        failureStorage,
        metadataStorage,
        persistence: createBrowserWASQLitePersistence({ database }),
        vault: await unlockVault("clinical-records private passphrase", salt),
        onlineDetector: connection,
        leaderElection: leader(),
        onAuthRequired() {},
      });
      await Promise.all([space.collection.preload(), space.clinicalRecords.preload()]);
      return space;
    };
    let workspace = await open();
    await Promise.all([workspace.collection.preload(), workspace.clinicalRecords.preload()]);
    expect(workspace.clinicalRecords.size).toBe(1); // An encrypted preparation marker, no medical record.
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await workspace.clinicalRecords.preload();
    expect(workspace.clinicalRecords.status).toBe("ready");
    const clientId = crypto.randomUUID();
    const privateContent = "Confidential clinical content";
    const payload: ClinicalPayload =
      kind === "history"
        ? {
            kind: "history",
            occurredOn: "2020-01-01",
            notes: "Private clinical note",
            text: privateContent,
          }
        : {
            kind: "visit",
            occurredOn: "2026-11-01",
            notes: "Private clinical note",
            scheduledFor: "2026-11-01T01:30:00-04:00[America/New_York]",
            durationMinutes: 30,
            visitType: "consultation",
            status: "planned",
            reason: privateContent,
            location: "Private place",
            outcome: "",
            followUpOn: "",
            cancellationReason: "",
          };
    const queued = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 0,
      action: "create",
      payload,
    });
    expect(calls).toBe(0);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(privateContent);
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toEqual(
      payload,
    );
    await refresh();
    const completion = workspace.executor.waitForTransactionCompletion(queued.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await completion;
    expect(calls).toBe(1);
    expect(
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }),
    ).toHaveLength(1);
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toEqual(
      payload,
    );
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const storedRows = tables.flatMap((table) =>
      sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
    );
    expect(JSON.stringify(storedRows)).not.toContain(privateContent);
    expect(JSON.stringify(storedRows)).not.toContain(payload.notes);
    await refresh();
    connection.disconnect();
    const conflict = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 1,
      action: "update",
      payload: { ...payload, notes: "Rejected local clinical draft" },
    });
    await doctor.mutation(api.clinicalRecords.apply, {
      actorId: "doctor",
      organizationId,
      clientId,
      patientClientId,
      expectedRevision: 1,
      action: "update",
      payload: { ...payload, notes: "Authoritative clinical history" },
      idempotencyKey: "another-doctor",
    });
    await refresh();
    const conflictSettled = workspace.executor.waitForTransactionCompletion(conflict.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await expect(conflictSettled).rejects.toThrow();
    const rejected = await workspace.failedActions("clinical");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe("REVISION_CONFLICT");
    expect(workspace.readClinical(rejected[0]!.envelope).payload).toMatchObject({
      notes: "Rejected local clinical draft",
    });
    expect(JSON.stringify([...failureStorage.values.values()])).not.toContain(
      "Rejected local clinical draft",
    );
    await expect(
      workspace.saveClinical({
        clientId,
        patientClientId,
        expectedRevision: 1,
        action: "update",
        payload,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    connection.disconnect();
    const updated = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 2,
      action: "update",
      payload: { ...payload, notes: "Confirmed clinical revision" },
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await refresh();
    const updatedSettled = workspace.executor.waitForTransactionCompletion(updated.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await updatedSettled;
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).revision).toBe(3);
    connection.disconnect();
    const deleted = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 3,
      action: "delete",
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toBeNull();
    await refresh();
    const deletedSettled = workspace.executor.waitForTransactionCompletion(deleted.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await deletedSettled;
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }))[0],
    ).toMatchObject({ deleted: true, payload: null, revision: 4 });
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    await workspace.close();
    sqlite.close();
  },
);
