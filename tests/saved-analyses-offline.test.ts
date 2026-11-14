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
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { defaultCohortComparison } from "@/src/lib/cohort-comparison-model";
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
  "../convex/analyses.ts": () => import("@/convex/analyses"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
it("restores a researcher analysis and encrypted CAS failures across offline restarts", async () => {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "University",
    kind: "university",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  await t.mutation(internal.provisioning.approveMembership, {
    userId: "researcher",
    organizationId,
    role: "researcher",
  });
  const actor = t.withIdentity({ subject: "researcher" });
  const snapshots = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const refresh = async () => {
    for (const fn of [
      api.patients.list,
      api.patients.versions,
      api.clinicalRecords.list,
      api.clinicalRecords.versions,
      api.analyses.list,
    ])
      snapshots.set(
        getFunctionName(fn),
        await actor.query(fn, { actorId: "researcher", organizationId }),
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
      const result = await actor.mutation(fn, args);
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
  const failures = memoryStorage();
  const metadata = memoryStorage();
  const salt = newVaultSalt();
  let connection = network();
  const open = async () => {
    connection = network();
    const space = await openPatientWorkspace({
      client,
      userId: "researcher",
      organizationId,
      role: "researcher",
      expiresAt: Date.now() + 60000,
      storage,
      failureStorage: failures,
      metadataStorage: metadata,
      persistence: createBrowserWASQLitePersistence({ database }),
      vault: await unlockVault("private analysis vault passphrase", salt),
      onlineDetector: connection,
      leaderElection: leader(),
      onAuthRequired() {},
    });
    await Promise.all([space.collection.preload(), space.analyses.preload()]);
    return space;
  };
  let workspace = await open();
  expect(workspace.analyses.size).toBe(1);
  await workspace.close();
  snapshots.clear();
  workspace = await open();
  expect(workspace.analyses.status).toBe("ready");
  const clientId = crypto.randomUUID();
  const values = {
    comparison: {
      ...defaultCohortComparison,
      outcome: { kind: "diagnosis" as const, code: "F41" },
    },
    title: "Confidential analysis title",
    description: "Confidential analysis description",
    criteria: { ...defaultCohortCriteria, include: ["F41"] },
  };
  const queued = await workspace.saveAnalysis({
    clientId,
    expectedRevision: 0,
    action: "create",
    values,
  });
  expect(calls).toBe(0);
  expect(JSON.stringify([...storage.values.values()])).not.toContain(values.title);
  await workspace.close();
  snapshots.clear();
  workspace = await open();
  expect(workspace.readAnalysis(workspace.analyses.get(clientId)!).values).toEqual(values);
  await refresh();
  let settled = workspace.executor.waitForTransactionCompletion(queued.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await settled;
  expect(calls).toBe(1);
  await workspace.close();
  snapshots.clear();
  workspace = await open();
  expect(workspace.readAnalysis(workspace.analyses.get(clientId)!).values).toEqual(values);
  expect(await workspace.executor.peekOutbox()).toEqual([]);
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const disk = JSON.stringify(
    tables.flatMap((table) =>
      sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
    ),
  );
  expect(disk).not.toContain(values.title);
  expect(disk).not.toContain(values.description);
  const local = await workspace.saveAnalysis({
    clientId,
    expectedRevision: 1,
    action: "update",
    values: { ...values, title: "Rejected analysis draft" },
  });
  await actor.mutation(api.analyses.apply, {
    actorId: "researcher",
    organizationId,
    clientId,
    expectedRevision: 1,
    action: "update",
    values: { ...values, title: "Authoritative title" },
    idempotencyKey: "other-tab",
  });
  await refresh();
  settled = workspace.executor.waitForTransactionCompletion(local.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await expect(settled).rejects.toThrow();
  const rejected = await workspace.failedActions("analysis");
  expect(rejected[0]?.code).toBe("REVISION_CONFLICT");
  expect(workspace.readAnalysis(rejected[0]!.envelope).values?.title).toBe(
    "Rejected analysis draft",
  );
  expect(JSON.stringify([...failures.values.values()])).not.toContain("Rejected analysis draft");
  await expect(
    workspace.saveAnalysis({ clientId, expectedRevision: 1, action: "update", values }),
  ).rejects.toThrow("REVISION_CONFLICT");
  connection.disconnect();
  const update = await workspace.saveAnalysis({
    clientId,
    expectedRevision: 2,
    action: "update",
    values: { ...values, title: "Confirmed title" },
  });
  await workspace.close();
  snapshots.clear();
  workspace = await open();
  await refresh();
  settled = workspace.executor.waitForTransactionCompletion(update.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await settled;
  expect(workspace.readAnalysis(workspace.analyses.get(clientId)!).revision).toBe(3);
  connection.disconnect();
  const deletion = await workspace.saveAnalysis({
    clientId,
    expectedRevision: 3,
    action: "delete",
  });
  await workspace.close();
  snapshots.clear();
  workspace = await open();
  expect(workspace.readAnalysis(workspace.analyses.get(clientId)!).values).toBeNull();
  await refresh();
  settled = workspace.executor.waitForTransactionCompletion(deletion.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await settled;
  expect(
    (await actor.query(api.analyses.list, { actorId: "researcher", organizationId }))[0],
  ).toMatchObject({ revision: 4, deleted: true, values: null });
  expect(await workspace.executor.peekOutbox()).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("patients").collect())).toEqual([]);
  await workspace.close();
  sqlite.close();
});
