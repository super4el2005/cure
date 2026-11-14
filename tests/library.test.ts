import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { libraryEntrySchema } from "@/src/lib/library-model";
import type { LibraryEntry } from "@/src/lib/library-model";
import { openLibraryWorkspace } from "@/src/lib/library-workspace";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
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
  "../convex/library.ts": () => import("@/convex/library"),
  "../convex/profiles.ts": () => import("@/convex/profiles"),
};
const entry: LibraryEntry = {
  title: "Private research source",
  doi: "10.1234/example",
  pmid: "123",
  url: "https://pubmed.ncbi.nlm.nih.gov/123/",
  citation: "Journal 2026",
  authors: "Author One",
  year: 2026,
  collection: "Private collection",
  tags: ["review"],
  notes: "Confidential research notes",
  status: "toRead",
  exclusionReason: "",
  source: "pubmed",
  fetchedAt: Date.now(),
};
async function setup() {
  const t = convexTest(schema, modules);
  const doctor = t.withIdentity({ subject: "doctor" });
  const researcher = t.withIdentity({ subject: "researcher" });
  for (const [actor, actorId, profession] of [
    [doctor, "doctor", "doctor"],
    [researcher, "researcher", "researcher"],
  ] as const)
    await actor.mutation(api.profiles.save, {
      actorId,
      displayName: actorId,
      profession,
      specialty: "",
      interests: [],
      languages: [],
      bio: "",
      published: false,
    });
  const args = {
    actorId: "doctor",
    clientId: crypto.randomUUID(),
    writeId: crypto.randomUUID(),
    expectedWriteId: null as string | null,
    expectedRevision: 0,
    action: "create" as const,
    entry,
    idempotencyKey: "first",
  };
  return { t, doctor, researcher, args };
}
describe("personal library ownership, snapshots and history", () => {
  it("validates references without accepting credentials, unsafe links or missing exclusion rationale", () => {
    expect(libraryEntrySchema.safeParse(entry).success).toBe(true);
    expect(libraryEntrySchema.safeParse({ ...entry, url: "", doi: "", pmid: "" }).success).toBe(
      true,
    );
    for (const url of [
      "javascript:alert(1)",
      "http://example.com",
      "https://user:password@example.com",
    ])
      expect(libraryEntrySchema.safeParse({ ...entry, url }).success).toBe(false);
    expect(libraryEntrySchema.safeParse({ ...entry, doi: "not-a-doi" }).success).toBe(false);
    expect(libraryEntrySchema.safeParse({ ...entry, status: "excluded" }).success).toBe(false);
    expect(libraryEntrySchema.safeParse({ ...entry, tags: ["tag", "TAG"] }).success).toBe(false);
  });
  it("keeps papers personal across institutions and checks actor ownership before receipts", async () => {
    const { t, doctor, researcher, args } = await setup();
    const lease = await doctor.query(api.library.offlineLease, {
      actorId: "doctor",
      nonce: crypto.randomUUID(),
    });
    expect(lease).toMatchObject({ userId: "doctor", purpose: "library" });
    expect(await doctor.mutation(api.library.apply, args)).toEqual({ revision: 1 });
    expect(await doctor.mutation(api.library.apply, args)).toEqual({ revision: 1 });
    expect(await researcher.query(api.library.list, { actorId: "researcher" })).toEqual([]);
    expect(await researcher.query(api.library.versions, { actorId: "researcher" })).toEqual([]);
    await expect(
      researcher.mutation(api.library.apply, { ...args, actorId: "researcher" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(researcher.mutation(api.library.apply, args)).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      t
        .withIdentity({ subject: "new" })
        .query(api.library.offlineLease, { actorId: "new", nonce: "fresh" }),
    ).rejects.toThrow("PROFILE_REQUIRED");
    await expect(t.query(api.library.list, { actorId: "doctor" })).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    const own = {
      ...args,
      actorId: "researcher",
      clientId: crypto.randomUUID(),
      writeId: crypto.randomUUID(),
      entry: { ...entry, notes: "Researcher private notes" },
    };
    expect(await researcher.mutation(api.library.apply, own)).toEqual({ revision: 1 });
    expect(
      (await researcher.query(api.library.list, { actorId: "researcher" })).map(
        (row) => row.clientId,
      ),
    ).toEqual([own.clientId]);
    expect(
      (await doctor.query(api.library.list, { actorId: "doctor" })).map((row) => row.clientId),
    ).toEqual([args.clientId]);
    const audit = await t.run((ctx) => ctx.db.query("libraryAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Private|Confidential|Author|example/);
  });
  it("retains full immutable revisions beyond thirty edits and clears history in bounded deletion batches", async () => {
    const { t, doctor, args } = await setup();
    let previous = args;
    await doctor.mutation(api.library.apply, args);
    for (let revision = 1; revision < 60; revision++) {
      const next = {
        ...args,
        action: "update" as const,
        expectedRevision: revision,
        expectedWriteId: previous.writeId,
        writeId: crypto.randomUUID(),
        entry: { ...entry, notes: `Private revision ${revision + 1}` },
        idempotencyKey: `revision-${revision + 1}`,
      };
      await doctor.mutation(api.library.apply, next);
      previous = { ...next, action: "create" };
    }
    const versions = await doctor.query(api.library.versions, { actorId: "doctor" });
    expect(versions).toHaveLength(60);
    expect(versions.find((row) => row.revision === 1)?.entry.notes).toBe(entry.notes);
    await expect(
      doctor.mutation(api.library.apply, {
        ...args,
        action: "update",
        expectedRevision: 60,
        expectedWriteId: args.writeId,
        writeId: crypto.randomUUID(),
        idempotencyKey: "bad-predecessor",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    rstest.useFakeTimers();
    try {
      const { entry: _entry, ...remove } = args;
      await doctor.mutation(api.library.apply, {
        ...remove,
        action: "delete",
        expectedRevision: 60,
        expectedWriteId: previous.writeId,
        writeId: crypto.randomUUID(),
        idempotencyKey: "delete",
      });
      expect(await doctor.query(api.library.versions, { actorId: "doctor" })).toEqual([]);
      await t.finishAllScheduledFunctions(() => rstest.runAllTimers());
      expect(await t.run((ctx) => ctx.db.query("libraryVersions").collect())).toEqual([]);
      expect((await doctor.query(api.library.list, { actorId: "doctor" }))[0]).toMatchObject({
        deleted: true,
        entry: null,
        revision: 61,
      });
    } finally {
      rstest.useRealTimers();
    }
  });
});

it("restores the encrypted library and version projection from disk, rejects dependent conflicts, and isolates accounts", async () => {
  const { t, doctor, researcher, args } = await setup();
  const directory = mkdtempSync(join(tmpdir(), "cure-library-"));
  const path = join(directory, "library.sqlite");
  let sqlite = new DatabaseSync(path);
  sqlite.exec(
    "CREATE TABLE test_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))",
  );
  const storageFor = (namespace: string): StorageAdapter => ({
    async get(key) {
      return (
        (
          sqlite
            .prepare("SELECT value FROM test_kv WHERE namespace=? AND key=?")
            .get(namespace, key) as { value: string } | undefined
        )?.value ?? null
      );
    },
    async set(key, value) {
      sqlite
        .prepare(
          "INSERT INTO test_kv VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
        )
        .run(namespace, key, value);
    },
    async delete(key) {
      sqlite.prepare("DELETE FROM test_kv WHERE namespace=? AND key=?").run(namespace, key);
    },
    async keys() {
      return (
        sqlite
          .prepare("SELECT key FROM test_kv WHERE namespace=? ORDER BY rowid")
          .all(namespace) as { key: string }[]
      ).map((row) => row.key);
    },
    async clear() {
      sqlite.prepare("DELETE FROM test_kv WHERE namespace=?").run(namespace);
    },
  });
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
  let snapshots = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let actor = doctor;
  let userId = "doctor";
  let calls = 0;
  let authFailure = false;
  const refresh = async () => {
    for (const fn of [api.library.list, api.library.versions])
      snapshots.set(getFunctionName(fn), await actor.query(fn, { actorId: userId }));
    for (const listener of listeners) listener();
  };
  await refresh();
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
    async mutation(fn: FunctionReference<"mutation">, input: Record<string, Value>) {
      calls++;
      if (authFailure) throw new Error("UNAUTHENTICATED");
      const result = await actor.mutation(fn, input);
      await refresh();
      return result;
    },
  } as unknown as ConvexReactClient;
  let connection = network();
  let authRequired = 0;
  const salts = new Map([
    ["doctor", newVaultSalt()],
    ["researcher", newVaultSalt()],
  ]);
  const open = async () => {
    connection = network();
    const space = await openLibraryWorkspace({
      client,
      userId,
      expiresAt: Date.now() + 60000,
      vault: await unlockVault("private library passphrase", salts.get(userId)!),
      persistence: createBrowserWASQLitePersistence({ database }),
      storage: storageFor(`${userId}:outbox`),
      failureStorage: storageFor(`${userId}:failures`),
      onlineDetector: connection,
      leaderElection: leader(),
      onAuthRequired() {
        authRequired++;
      },
    });
    await Promise.all([space.collection.preload(), space.versions.preload()]);
    return space;
  };
  let workspace = await open();
  expect(workspace.collection.size).toBe(1);
  expect(workspace.versions.size).toBe(1);
  const restart = async () => {
    await workspace.close();
    sqlite.close();
    sqlite = new DatabaseSync(path);
    snapshots = new Map();
    workspace = await open();
  };
  await restart();
  expect(workspace.collection.status).toBe("ready");
  expect(workspace.versions.status).toBe("ready");
  const queued = await workspace.save({
    clientId: args.clientId,
    expectedRevision: 0,
    action: "create",
    entry,
  });
  const local = workspace.read(workspace.collection.get(args.clientId)!);
  expect(calls).toBe(0);
  expect(workspace.versions.size).toBe(2);
  expect(workspace.readVersion(workspace.versions.get(local.writeId)!).confirmed).toBe(false);
  await restart();
  expect(workspace.read(workspace.collection.get(args.clientId)!)).toEqual(local);
  expect(workspace.readVersion(workspace.versions.get(local.writeId)!).entry.notes).toBe(
    entry.notes,
  );
  await refresh();
  const delivered = workspace.executor.waitForTransactionCompletion(queued.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await delivered;
  expect(calls).toBe(1);
  expect(workspace.readVersion(workspace.versions.get(local.writeId)!).confirmed).toBe(true);
  expect(await doctor.query(api.library.versions, { actorId: "doctor" })).toHaveLength(1);
  connection.disconnect();
  const a = await workspace.save({
    clientId: args.clientId,
    expectedRevision: 1,
    action: "update",
    entry: { ...entry, notes: "Private competing local note" },
  });
  const a2 = workspace.read(workspace.collection.get(args.clientId)!);
  const b = await workspace.save({
    clientId: args.clientId,
    expectedRevision: 2,
    action: "update",
    entry: { ...entry, notes: "Private dependent local note" },
  });
  await doctor.mutation(api.library.apply, {
    ...args,
    action: "update",
    expectedRevision: 1,
    expectedWriteId: local.writeId,
    writeId: crypto.randomUUID(),
    entry: { ...entry, notes: "Authoritative private note" },
    idempotencyKey: "concurrent",
  });
  await restart();
  await refresh();
  const both = Promise.allSettled(
    [a, b].map((row) => workspace.executor.waitForTransactionCompletion(row.transactionId)),
  );
  connection.connect();
  workspace.setAuthenticated(true);
  expect((await both).map((row) => row.status)).toEqual(["rejected", "rejected"]);
  const failures = await workspace.failedActions();
  expect(failures.map((row) => row.code)).toEqual(["REVISION_CONFLICT", "REVISION_CONFLICT"]);
  expect(workspace.read(failures[0]!.envelope).entry?.notes).toBe("Private competing local note");
  expect(await doctor.query(api.library.versions, { actorId: "doctor" })).toHaveLength(2);
  connection.disconnect();
  const corrected = await workspace.save({
    clientId: args.clientId,
    expectedRevision: 2,
    action: "update",
    entry: { ...entry, notes: "Reviewed correction" },
  });
  authFailure = true;
  connection.connect();
  workspace.setAuthenticated(true);
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (authRequired) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("AUTH_NOT_PAUSED"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
  expect(workspace.requiresAuthentication()).toBe(true);
  workspace.setAuthenticated(true);
  expect(workspace.executor.isOnline()).toBe(false);
  authFailure = false;
  const confirmation = workspace.executor.waitForTransactionCompletion(corrected.transactionId);
  workspace.confirmAuthentication();
  await confirmation;
  await restart();
  await refresh();
  connection.connect();
  workspace.setAuthenticated(true);
  expect(workspace.read(workspace.collection.get(args.clientId)!).revision).toBe(3);
  const foreign = workspace.collection.get(args.clientId)!;
  await workspace.close();
  snapshots = new Map();
  userId = "researcher";
  actor = researcher;
  await refresh();
  workspace = await open();
  expect(workspace.collection.size).toBe(1);
  expect(await workspace.executor.peekOutbox()).toEqual([]);
  expect(() => workspace.read(foreign)).toThrow("VAULT_UNLOCK_FAILED");
  await workspace.close();
  snapshots = new Map();
  userId = "doctor";
  actor = doctor;
  await refresh();
  workspace = await open();
  const deleted = await workspace.save({
    clientId: args.clientId,
    expectedRevision: 3,
    action: "delete",
  });
  await restart();
  expect(workspace.read(workspace.collection.get(args.clientId)!).entry).toBeNull();
  expect(() => workspace.readVersion(workspace.versions.get(local.writeId)!)).toThrow(
    "LIBRARY_ITEM_DELETED",
  );
  await refresh();
  const deletion = workspace.executor.waitForTransactionCompletion(deleted.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await deletion;
  expect(await doctor.query(api.library.versions, { actorId: "doctor" })).toEqual([]);
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  expect(
    JSON.stringify(
      tables.flatMap((table) =>
        sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
      ),
    ),
  ).not.toMatch(
    /Confidential|Private research source|Private collection|Author One|Journal 2026|10\.1234\/example|Private competing|Private dependent|Authoritative private|Reviewed correction/,
  );
  await workspace.close();
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
