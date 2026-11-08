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
import type { FunctionReference, FunctionArgs } from "convex/server";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openProjectWorkspace } from "@/src/lib/project-workspace";
import type { ProjectValues } from "@/src/lib/research-model";
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
  "../convex/projectTeams.ts": () => import("@/convex/projectTeams"),
  "../convex/protocols.ts": () => import("@/convex/protocols"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
describe("durable research projects", () => {
  it("restores an encrypted project draft after restart and reconciles server acknowledgement", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.mutation(internal.provisioning.createOrganization, {
      name: "University",
      kind: "university",
      country: "RU",
      city: "",
      description: "",
      published: true,
    });
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "researcher",
      organizationId,
      role: "researcher",
    });
    const actor = t.withIdentity({ subject: "researcher" });
    let result: Awaited<ReturnType<typeof actor.query<typeof api.projects.mine>>> | undefined = [];
    let protocolResult:
      | Awaited<ReturnType<typeof actor.query<typeof api.protocols.mine>>>
      | undefined = [];
    const listeners = new Set<() => void>();
    let calls = 0;
    const client = {
      watchQuery(fn: FunctionReference<"query">) {
        const protocols = getFunctionName(fn) === getFunctionName(api.protocols.mine);
        const team = getFunctionName(fn) === getFunctionName(api.projectTeams.workspace);
        return {
          localQueryResult: () =>
            team ? (result === undefined ? undefined : []) : protocols ? protocolResult : result,
          onUpdate(callback: () => void) {
            listeners.add(callback);
            return () => {
              listeners.delete(callback);
            };
          },
        };
      },
      async mutation(
        fn: FunctionReference<"mutation">,
        args: FunctionArgs<typeof api.projects.apply> | FunctionArgs<typeof api.protocols.append>,
      ) {
        calls++;
        const response =
          getFunctionName(fn) === getFunctionName(api.protocols.append)
            ? await actor.mutation(
                api.protocols.append,
                args as FunctionArgs<typeof api.protocols.append>,
              )
            : await actor.mutation(
                api.projects.apply,
                args as FunctionArgs<typeof api.projects.apply>,
              );
        protocolResult = await actor.query(api.protocols.mine, {
          organizationId,
          actorId: "researcher",
        });
        result = await actor.query(api.projects.mine, { organizationId, actorId: "researcher" });
        for (const listener of listeners) listener();
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
    const failureStorage = memoryStorage();
    const salt = newVaultSalt();
    const config = {
      client,
      userId: "researcher",
      organizationId,
      role: "researcher" as const,
      expiresAt: Date.now() + 60000,
      storage,
      failureStorage,
      onAuthRequired() {},
    };
    const open = async (onlineDetector: ReturnType<typeof network>) =>
      openProjectWorkspace({
        ...config,
        onlineDetector,
        persistence: createBrowserWASQLitePersistence({ database }),
        leaderElection: leader(),
        vault: await unlockVault("private research workspace password", salt),
      });
    let workspace = await open(network());
    await workspace.collection.preload();
    const values: ProjectValues = {
      title: "Private research question",
      summary: "Confidential draft",
      topic: "Medicine",
      kind: "retrospective",
      status: "draft",
      published: false,
      publicEligibility: "",
      publicContact: "",
    };
    const clientId = crypto.randomUUID();
    const saved = await workspace.save({ clientId, values });
    await workspace.protocols.preload();
    const initialProtocol = await workspace.saveProtocol({
      clientId: crypto.randomUUID(),
      projectClientId: clientId,
      values: {
        hypothesis: "Initial private hypothesis",
        inclusion: "",
        exclusion: "",
        endpoints: "Initial outcome",
        analysisPlan: "Initial plan",
        ethicsApproved: false,
        ethicsReference: "",
        ethicsExpiresAt: 0,
      },
    });

    expect(calls).toBe(0);
    expect(await workspace.executor.peekOutbox()).toHaveLength(2);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(values.title);
    await workspace.close();
    result = undefined;
    protocolResult = undefined;
    const connection = network();
    workspace = await open(connection);
    expect(workspace.read(workspace.collection.get(clientId)!).title).toBe(values.title);
    result = [];
    const settled = workspace.executor.waitForTransactionCompletion(saved.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await settled;
    await workspace.executor.waitForTransactionCompletion(initialProtocol.transactionId);
    expect(calls).toBe(2);
    expect(
      await actor.query(api.projects.mine, { organizationId, actorId: "researcher" }),
    ).toHaveLength(1);
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    const revision = workspace.read(workspace.collection.get(clientId)!).revision;
    expect(revision).toBe(1);
    connection.disconnect();
    const edited = await workspace.save({
      clientId,
      values: { ...values, title: "Updated research question" },
    });
    expect(workspace.read(workspace.collection.get(clientId)!).revision).toBe(2);
    const nextSettled = workspace.executor.waitForTransactionCompletion(edited.transactionId);
    connection.connect();
    await nextSettled;
    expect(
      (await actor.query(api.projects.details, { clientId, actorId: "researcher" })).title,
    ).toBe("Updated research question");
    expect(await workspace.failedActions()).toEqual([]);
    connection.disconnect();
    const conflicting = await workspace.save({
      clientId,
      values: { ...values, title: "Preserved rejected draft" },
    });
    await actor.mutation(api.projects.apply, {
      actorId: "researcher",
      organizationId,
      clientId,
      expectedRevision: 2,
      idempotencyKey: "another-tab",
      values: { ...values, title: "Authoritative server title" },
    });
    result = await actor.query(api.projects.mine, { organizationId, actorId: "researcher" });
    for (const listener of listeners) listener();
    const conflictSettled = workspace.executor.waitForTransactionCompletion(
      conflicting.transactionId,
    );
    connection.connect();
    await expect(conflictSettled).rejects.toThrow();
    const rejected = await workspace.failedActions();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.code).toBe("REVISION_CONFLICT");
    expect(workspace.read(rejected[0]!.envelope).title).toBe("Preserved rejected draft");
    expect(workspace.read(workspace.collection.get(clientId)!).title).toBe(
      "Authoritative server title",
    );
    expect(JSON.stringify([...failureStorage.values.values()])).not.toContain(
      "Preserved rejected draft",
    );
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    connection.disconnect();
    await workspace.protocols.preload();
    const protocolValues = {
      hypothesis: "Confidential protocol hypothesis",
      inclusion: "Adults",
      exclusion: "",
      endpoints: "Primary outcome",
      analysisPlan: "Predefined analysis",
      ethicsApproved: false,
      ethicsReference: "",
      ethicsExpiresAt: 0,
    };
    const protocolSaved = await workspace.saveProtocol({
      clientId: crypto.randomUUID(),
      projectClientId: clientId,
      values: protocolValues,
    });
    expect(JSON.stringify([...storage.values.values()])).not.toContain(protocolValues.hypothesis);
    await workspace.close();
    result = undefined;
    protocolResult = undefined;
    const finalNetwork = network();
    workspace = await open(finalNetwork);
    expect(
      [...workspace.protocols.values()]
        .map(workspace.readProtocol)
        .some((row) => row.hypothesis === protocolValues.hypothesis),
    ).toBe(true);
    result = await actor.query(api.projects.mine, { organizationId, actorId: "researcher" });
    protocolResult = [];
    const protocolSettled = workspace.executor.waitForTransactionCompletion(
      protocolSaved.transactionId,
    );
    finalNetwork.connect();
    workspace.setAuthenticated(true);
    await protocolSettled;
    expect(
      await actor.query(api.protocols.history, {
        projectClientId: clientId,
        actorId: "researcher",
      }),
    ).toHaveLength(2);
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    await workspace.close();
    sqlite.close();
  });
});
