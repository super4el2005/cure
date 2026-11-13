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
  "../convex/studyForms.ts": () => import("@/convex/studyForms"),
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
    let formResult:
      | Awaited<ReturnType<typeof actor.query<typeof api.studyForms.mine>>>
      | undefined = [];
    const listeners = new Set<() => void>();
    let calls = 0;
    const client = {
      watchQuery(fn: FunctionReference<"query">) {
        const isForm = getFunctionName(fn) === getFunctionName(api.studyForms.mine);
        const protocols = getFunctionName(fn) === getFunctionName(api.protocols.mine);
        const team =
          getFunctionName(fn) === getFunctionName(api.studyForms.mine) ||
          getFunctionName(fn) === getFunctionName(api.projectTeams.workspace) ||
          getFunctionName(fn) === getFunctionName(api.projectWork.workspace);
        return {
          localQueryResult: () =>
            isForm
              ? formResult
              : team
                ? result === undefined
                  ? undefined
                  : []
                : protocols
                  ? protocolResult
                  : result,
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
        args:
          | FunctionArgs<typeof api.projects.apply>
          | FunctionArgs<typeof api.protocols.append>
          | FunctionArgs<typeof api.studyForms.append>,
      ) {
        calls++;
        const response =
          getFunctionName(fn) === getFunctionName(api.studyForms.append)
            ? await actor.mutation(
                api.studyForms.append,
                args as FunctionArgs<typeof api.studyForms.append>,
              )
            : getFunctionName(fn) === getFunctionName(api.protocols.append)
              ? await actor.mutation(
                  api.protocols.append,
                  args as FunctionArgs<typeof api.protocols.append>,
                )
              : await actor.mutation(
                  api.projects.apply,
                  args as FunctionArgs<typeof api.projects.apply>,
                );
        formResult = await actor.query(api.studyForms.mine, {
          organizationId,
          actorId: "researcher",
        });
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
    const open = async (onlineDetector: ReturnType<typeof network>) => {
      const opened = await openProjectWorkspace({
        ...config,
        onlineDetector,
        persistence: createBrowserWASQLitePersistence({ database }),
        leaderElection: leader(),
        vault: await unlockVault("private research workspace password", salt),
      });
      await opened.forms.preload();
      return opened;
    };
    let workspace = await open(network());
    await Promise.all([
      workspace.collection.preload(),
      workspace.protocols.preload(),
      workspace.team.preload(),
      workspace.work.preload(),
    ]);
    await workspace.close();
    result = undefined;
    protocolResult = undefined;
    workspace = await open(network());
    await Promise.all([
      workspace.collection.preload(),
      workspace.protocols.preload(),
      workspace.team.preload(),
      workspace.work.preload(),
    ]);
    expect(workspace.collection.status).toBe("ready");
    expect(workspace.protocols.status).toBe("ready");
    expect(workspace.team.status).toBe("ready");
    expect(workspace.work.status).toBe("ready");
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
    const saved = await workspace.save({ clientId, expectedRevision: 0, values });
    await workspace.protocols.preload();
    const initialProtocol = await workspace.saveProtocol({
      expectedVersion: 0,
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

    expect(
      [...workspace.protocols.values()]
        .filter((row) => row.clientId !== workspace.protocolSnapshotId)
        .map(workspace.readProtocol)
        .every((row) => !row.confirmed),
    ).toBe(true);
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
      expectedRevision: 1,
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
    await expect(
      workspace.save({
        clientId,
        expectedRevision: 1,
        values: { ...values, title: "Old open form" },
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    const conflicting = await workspace.save({
      expectedRevision: 2,
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
    await expect(
      workspace.saveProtocol({
        clientId: crypto.randomUUID(),
        projectClientId: clientId,
        expectedVersion: 0,
        values: protocolValues,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const protocolSaved = await workspace.saveProtocol({
      expectedVersion: 1,
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
        .filter((row) => row.clientId !== workspace.protocolSnapshotId)
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
      [...workspace.protocols.values()]
        .filter((row) => row.clientId !== workspace.protocolSnapshotId)
        .map(workspace.readProtocol)
        .every((row) => row.confirmed),
    ).toBe(true);
    expect(
      await actor.query(api.protocols.history, {
        projectClientId: clientId,
        actorId: "researcher",
      }),
    ).toHaveLength(2);
    expect(await workspace.executor.peekOutbox()).toEqual([]);

    finalNetwork.disconnect();
    const formClientId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const definition = {
      title: "Confidential form title",
      description: "Confidential form description",
      fields: [
        {
          id: crypto.randomUUID(),
          type: "text" as const,
          label: "Confidential question",
          help: "",
          required: true,
          maxLength: 100,
        },
      ],
    };
    const queuedForm = await workspace.saveForm({
      clientId: versionId,
      projectClientId: clientId,
      formClientId,
      expectedVersion: 0,
      baseVersionClientId: null,
      definition,
      status: "published",
    });
    expect(JSON.stringify([...storage.values.values()])).not.toContain(definition.title);
    await workspace.close();
    result = undefined;
    protocolResult = undefined;
    formResult = undefined;
    let formNetwork = network();
    workspace = await open(formNetwork);
    expect(workspace.readForm(workspace.forms.get(versionId)!).definition).toEqual(definition);
    expect(workspace.readForm(workspace.forms.get(versionId)!).confirmed).toBe(false);
    result = await actor.query(api.projects.mine, { organizationId, actorId: "researcher" });
    protocolResult = await actor.query(api.protocols.mine, {
      organizationId,
      actorId: "researcher",
    });
    formResult = [];
    const formSettled = workspace.executor.waitForTransactionCompletion(queuedForm.transactionId);
    formNetwork.connect();
    workspace.setAuthenticated(true);
    await formSettled;
    expect(workspace.readForm(workspace.forms.get(versionId)!).confirmed).toBe(true);
    expect(
      await actor.query(api.studyForms.mine, { organizationId, actorId: "researcher" }),
    ).toHaveLength(1);
    formNetwork.disconnect();
    const rejectedVersionId = crypto.randomUUID();
    const rejectedForm = await workspace.saveForm({
      clientId: rejectedVersionId,
      projectClientId: clientId,
      formClientId,
      expectedVersion: 1,
      baseVersionClientId: versionId,
      definition: { ...definition, title: "Rejected form title" },
      status: "published",
    });
    const dependentForm = await workspace.saveForm({
      clientId: crypto.randomUUID(),
      projectClientId: clientId,
      formClientId,
      expectedVersion: 2,
      baseVersionClientId: rejectedVersionId,
      definition: { ...definition, title: "Dependent form title" },
      status: "published",
    });
    await actor.mutation(api.studyForms.append, {
      actorId: "researcher",
      organizationId,
      clientId: crypto.randomUUID(),
      projectClientId: clientId,
      formClientId,
      expectedVersion: 1,
      baseVersionClientId: versionId,
      definition: { ...definition, title: "Authoritative form title" },
      status: "retired",
      idempotencyKey: "another-tab-form",
    });
    await workspace.close();
    result = undefined;
    protocolResult = undefined;
    formResult = undefined;
    formNetwork = network();
    workspace = await open(formNetwork);
    await workspace.collection.preload();
    result = await actor.query(api.projects.mine, { organizationId, actorId: "researcher" });
    protocolResult = await actor.query(api.protocols.mine, {
      organizationId,
      actorId: "researcher",
    });
    formResult = await actor.query(api.studyForms.mine, { organizationId, actorId: "researcher" });
    for (const listener of listeners) listener();
    const rejectedSettled = workspace.executor.waitForTransactionCompletion(
      rejectedForm.transactionId,
    );
    const dependentSettled = workspace.executor.waitForTransactionCompletion(
      dependentForm.transactionId,
    );
    const both = Promise.allSettled([rejectedSettled, dependentSettled]);
    formNetwork.connect();
    workspace.setAuthenticated(true);
    expect((await both).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(
      await actor.query(api.studyForms.mine, { organizationId, actorId: "researcher" }),
    ).toHaveLength(2);
    expect(await workspace.failedActions("form")).toHaveLength(2);
    const archived = (await workspace.failedActions("form"))[0]!;
    expect(archived.code).toBe("REVISION_CONFLICT");
    expect(workspace.readForm(archived.envelope).definition.title).toBe("Rejected form title");
    expect(JSON.stringify([...failureStorage.values.values()])).not.toContain(
      "Rejected form title",
    );
    await expect(
      workspace.saveForm({
        clientId: crypto.randomUUID(),
        projectClientId: clientId,
        formClientId,
        expectedVersion: 1,
        baseVersionClientId: versionId,
        definition,
        status: "published",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    await workspace.close();
    sqlite.close();
  });
});
