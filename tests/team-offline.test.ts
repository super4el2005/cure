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
import type { Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openProjectWorkspace } from "@/src/lib/project-workspace";
import type { ProjectValues } from "@/src/lib/research-model";
import type { TeamRecord } from "@/src/lib/team-model";
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
  "../convex/profiles.ts": () => import("@/convex/profiles"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/protocols.ts": () => import("@/convex/protocols"),
  "../convex/projectWork.ts": () => import("@/convex/projectWork"),
  "../convex/projectTeams.ts": () => import("@/convex/projectTeams"),
};
describe("durable cross-organization collaboration", () => {
  it("restores invitations and decisions, grants access only after server acceptance and rejects stale removal", async () => {
    const t = convexTest(schema, modules);
    const organizations = await Promise.all(
      ["Clinic", "University"].map((name) =>
        t.mutation(internal.provisioning.createOrganization, {
          name,
          kind: "university",
          country: "RU",
          city: "",
          description: "",
          published: true,
        }),
      ),
    );
    const ownerOrg = organizations[0]!;
    const guestOrg = organizations[1]!;
    for (const [userId, organizationId] of [
      ["owner", ownerOrg],
      ["guest", guestOrg],
    ] as const)
      await t.mutation(internal.provisioning.approveMembership, {
        userId,
        organizationId,
        role: "researcher",
      });
    const owner = t.withIdentity({ subject: "owner" });
    const guest = t.withIdentity({ subject: "guest" });
    const profileId = await guest.mutation(api.profiles.save, {
      actorId: "guest",
      displayName: "Invited investigator",
      profession: "researcher",
      specialty: "Medicine",
      interests: [],
      languages: [],
      bio: "",
      published: true,
    });
    await t.mutation(internal.provisioning.verifyProfile, { userId: "guest", verified: true });
    const projectId = crypto.randomUUID();
    const values: ProjectValues = {
      title: "Private multicentre research",
      summary: "",
      topic: "",
      kind: "retrospective",
      status: "draft",
      published: false,
      publicEligibility: "",
      publicContact: "",
    };
    await owner.mutation(api.projects.apply, {
      actorId: "owner",
      organizationId: ownerOrg,
      clientId: projectId,
      idempotencyKey: "create",
      expectedRevision: 0,
      values,
    });
    async function harness(userId: string, organizationId: Id<"organizations">) {
      const actor = t.withIdentity({ subject: userId });
      let snapshots = new Map<string, unknown>();
      const listeners = new Set<() => void>();
      async function refresh() {
        for (const fn of [
          api.projects.mine,
          api.protocols.mine,
          api.projectTeams.workspace,
          api.projectWork.workspace,
        ])
          snapshots.set(
            getFunctionName(fn),
            await actor.query(fn, { actorId: userId, organizationId }),
          );
        for (const listener of listeners) listener();
      }
      await refresh();
      let deliveryCount = 0;
      const client = {
        watchQuery(fn: FunctionReference<"query">) {
          return {
            localQueryResult: () => snapshots.get(getFunctionName(fn)),
            onUpdate(callback: () => void) {
              listeners.add(callback);
              return () => {
                listeners.delete(callback);
              };
            },
          };
        },
        async mutation(fn: FunctionReference<"mutation">, args: Record<string, Value>) {
          deliveryCount++;
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
      const failureStorage = memoryStorage();
      const salt = newVaultSalt();
      let connection = network();
      const open = async () => {
        connection = network();
        const workspace = await openProjectWorkspace({
          client,
          userId,
          organizationId,
          role: "researcher",
          expiresAt: Date.now() + 60000,
          storage,
          failureStorage,
          persistence: createBrowserWASQLitePersistence({ database }),
          onlineDetector: connection,
          leaderElection: leader(),
          vault: await unlockVault("a private clinical collaboration passphrase", salt),
          onAuthRequired() {},
        });
        if (snapshots.size > 0)
          await Promise.all([
            workspace.collection.preload(),
            workspace.team.preload(),
            workspace.protocols.preload(),
          ]);
        return workspace;
      };
      return {
        open,
        refresh,
        forget: () => {
          snapshots = new Map();
        },
        reconnect: () => connection.connect(),
        disconnect: () => connection.disconnect(),
        storage,
        failureStorage,
        sqlite,
        calls: () => deliveryCount,
      };
    }
    const host = await harness("owner", ownerOrg);
    let hostSpace = await host.open();
    const inviteId = crypto.randomUUID();
    const queuedInvite = await hostSpace.saveTeam({
      operation: "invite",
      projectClientId: projectId,
      clientId: inviteId,
      targetProfileId: profileId,
      inviteeName: "Invited investigator",
      role: "member",
    });
    expect(host.calls()).toBe(0);
    expect(await guest.query(api.projectTeams.invitations, { actorId: "guest" })).toEqual([]);
    expect(JSON.stringify([...host.storage.values.values()])).not.toContain("Invited investigator");
    await hostSpace.close();
    host.forget();
    hostSpace = await host.open();
    const draft = [...hostSpace.team.values()]
      .map(hostSpace.readTeam)
      .find((row) => row.entity === "invitation");
    expect(draft?.delivery).toBe("local");
    await host.refresh();
    const delivered = hostSpace.executor.waitForTransactionCompletion(queuedInvite.transactionId);
    host.reconnect();
    hostSpace.setAuthenticated(true);
    await delivered;
    expect(host.calls()).toBe(1);
    expect(await guest.query(api.projectTeams.invitations, { actorId: "guest" })).toHaveLength(1);
    const recipient = await harness("guest", guestOrg);
    let recipientSpace = await recipient.open();
    const incoming = [...recipientSpace.team.values()]
      .map(recipientSpace.readTeam)
      .find((row) => row.entity === "invitation")!;
    expect(incoming.entity).toBe("invitation");
    expect(
      await guest.query(api.projects.mine, { actorId: "guest", organizationId: guestOrg }),
    ).toEqual([]);
    expect(
      [...recipientSpace.team.values()]
        .map(recipientSpace.readTeam)
        .filter((row) => row.entity === "member"),
    ).toEqual([]);
    const accepted = await recipientSpace.saveTeam({
      expectedRevision: incoming.revision,
      operation: "respond",
      key: incoming.key,
      decision: "accept",
    });
    expect(recipientSpace.collection.size).toBe(0);
    await recipientSpace.close();
    recipient.forget();
    recipientSpace = await recipient.open();
    expect(
      [...recipientSpace.team.values()]
        .map(recipientSpace.readTeam)
        .find((row) => row.key === incoming.key),
    ).toMatchObject({ status: "accepted", delivery: "local" });
    await recipient.refresh();
    const acceptance = recipientSpace.executor.waitForTransactionCompletion(accepted.transactionId);
    recipient.reconnect();
    recipientSpace.setAuthenticated(true);
    await acceptance;
    expect(recipient.calls()).toBe(1);
    expect(recipientSpace.collection.size).toBe(1);
    expect(
      (await guest.query(api.projects.details, { actorId: "guest", clientId: projectId }))
        .affiliationId,
    ).toBe(guestOrg);
    // A member's private research discussion and task also survive a cold restart.
    recipient.disconnect();
    const messageId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const message = await recipientSpace.saveWork({
      entity: "message",
      expectedRevision: 0,
      clientId: messageId,
      projectClientId: projectId,
      action: "create",
      body: "Private research discussion",
    });
    const taskValues = {
      title: "Prepare confidential analysis",
      description: "Internal methodology",
      status: "todo" as const,
      priority: "normal" as const,
      assigneeId: "guest",
      dueAt: Date.now() + 86400000,
      archived: false,
    };
    const task = await recipientSpace.saveWork({
      entity: "task",
      expectedRevision: 0,
      clientId: taskId,
      projectClientId: projectId,
      values: taskValues,
    });
    expect(JSON.stringify([...recipient.storage.values.values()])).not.toContain(
      "Private research discussion",
    );
    await recipientSpace.close();
    recipient.forget();
    recipientSpace = await recipient.open();
    expect(
      [...recipientSpace.work.values()]
        .map(recipientSpace.readWork)
        .find((row) => row.entity === "message"),
    ).toMatchObject({ body: "Private research discussion", delivery: "local" });
    expect(
      [...recipientSpace.work.values()]
        .map(recipientSpace.readWork)
        .find((row) => row.entity === "task"),
    ).toMatchObject({ title: taskValues.title, delivery: "local" });
    await recipient.refresh();
    const messageSent = recipientSpace.executor.waitForTransactionCompletion(message.transactionId);
    const taskSent = recipientSpace.executor.waitForTransactionCompletion(task.transactionId);
    recipient.reconnect();
    recipientSpace.setAuthenticated(true);
    await messageSent;
    await taskSent;
    expect(
      await guest.query(api.projectWork.workspace, { organizationId: guestOrg, actorId: "guest" }),
    ).toHaveLength(2);
    await expect(
      owner.mutation(api.projectWork.saveMessage, {
        actorId: "owner",
        clientId: messageId,
        projectClientId: projectId,
        action: "update",
        body: "Altered authorship",
        expectedRevision: 1,
        idempotencyKey: "forged-edit",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    // An editor's captured revision must not follow a newer live subscription silently.
    await guest.mutation(api.projectWork.saveMessage, {
      actorId: "guest",
      clientId: messageId,
      projectClientId: projectId,
      action: "update",
      body: "New authoritative message",
      expectedRevision: 1,
      idempotencyKey: "other-tab-message",
    });
    await owner.mutation(api.projectWork.saveTask, {
      actorId: "owner",
      clientId: taskId,
      projectClientId: projectId,
      values: { ...taskValues, status: "inProgress" },
      expectedRevision: 1,
      idempotencyKey: "other-tab-task",
    });
    await recipient.refresh();
    await expect(
      recipientSpace.saveWork({
        entity: "message",
        clientId: messageId,
        projectClientId: projectId,
        expectedRevision: 1,
        action: "update",
        body: "Stale unsaved editor",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      recipientSpace.saveWork({
        entity: "task",
        clientId: taskId,
        projectClientId: projectId,
        expectedRevision: 1,
        values: { ...taskValues, status: "done" },
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(await recipientSpace.executor.peekOutbox()).toEqual([]);
    expect(
      [...recipientSpace.work.values()]
        .map(recipientSpace.readWork)
        .find((row) => row.entity === "message"),
    ).toMatchObject({ body: "New authoritative message", revision: 2 });
    // Removing a guest belongs to the owner's scope even though their affiliation differs.
    await host.refresh();
    host.disconnect();
    const member = [...hostSpace.team.values()]
      .map(hostSpace.readTeam)
      .find(
        (row): row is Extract<TeamRecord, { entity: "member" }> =>
          row.entity === "member" && row.userId === "guest",
      )!;
    const removal = await hostSpace.saveTeam({
      expectedRevision: member.revision,
      operation: "setMember",
      key: member.key,
      role: "member",
      active: false,
    });
    await owner.mutation(api.projectTeams.setMember, {
      actorId: "owner",
      projectClientId: projectId,
      targetUserId: "guest",
      role: "viewer",
      active: true,
      expectedRevision: 1,
      idempotencyKey: "another-coordinator",
    });
    await recipient.refresh();
    await expect(
      recipientSpace.saveWork({
        entity: "task",
        expectedRevision: 1,
        clientId: taskId,
        projectClientId: projectId,
        values: { ...taskValues, status: "done" },
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      guest.mutation(api.projectWork.saveMessage, {
        actorId: "guest",
        clientId: messageId,
        projectClientId: projectId,
        action: "update",
        body: "Forbidden",
        expectedRevision: 1,
        idempotencyKey: "viewer-edit",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await host.refresh();
    const removalSettled = hostSpace.executor.waitForTransactionCompletion(removal.transactionId);
    host.reconnect();
    await expect(removalSettled).rejects.toThrow();
    const failures = await hostSpace.failedActions("team");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "REVISION_CONFLICT", operation: "setMember" });
    expect(hostSpace.readTeam(failures[0]!.envelope)).toMatchObject({
      active: false,
      role: "member",
    });
    expect(
      [...hostSpace.team.values()].map(hostSpace.readTeam).find((row) => row.key === member.key),
    ).toMatchObject({ active: true, role: "viewer" });
    expect(JSON.stringify([...host.failureStorage.values.values()])).not.toContain(
      "Invited investigator",
    );
    await expect(
      hostSpace.saveTeam({
        operation: "setMember",
        expectedRevision: 1,
        key: member.key,
        role: "member",
        active: false,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(await hostSpace.executor.peekOutbox()).toEqual([]);
    // Re-evaluate the current record, then remove using its current revision.
    const confirmedRemoval = await hostSpace.saveTeam({
      expectedRevision: 2,
      operation: "setMember",
      key: member.key,
      role: "viewer",
      active: false,
    });
    await hostSpace.executor.waitForTransactionCompletion(confirmedRemoval.transactionId);
    await expect(
      guest.query(api.projects.details, { actorId: "guest", clientId: projectId }),
    ).rejects.toThrow("ACCESS_DENIED");
    // Snapshot titles prevent old invitations from leaking later private changes.
    await owner.mutation(api.projects.apply, {
      actorId: "owner",
      organizationId: ownerOrg,
      clientId: projectId,
      expectedRevision: 1,
      idempotencyKey: "rename",
      values: { ...values, title: "Later private title" },
    });
    const formerInvites = await guest.query(api.projectTeams.invitations, { actorId: "guest" });
    expect(formerInvites[0]?.projectTitle).toBe(values.title);
    expect(formerInvites[0]?.projectStatus).toBeNull();
    expect(
      JSON.stringify(
        await guest.query(api.projectTeams.workspace, {
          organizationId: guestOrg,
          actorId: "guest",
        }),
      ),
    ).not.toContain("Later private title");
    await host.refresh();
    const secondId = crypto.randomUUID();
    const secondInvite = await hostSpace.saveTeam({
      operation: "invite",
      projectClientId: projectId,
      clientId: secondId,
      targetProfileId: profileId,
      inviteeName: "Invited investigator",
      role: "viewer",
    });
    await hostSpace.executor.waitForTransactionCompletion(secondInvite.transactionId);
    await recipient.refresh();
    recipient.disconnect();
    const stale = await recipientSpace.saveTeam({
      expectedRevision: 1,
      operation: "respond",
      key: `invitation:${secondId}`,
      decision: "accept",
    });
    host.disconnect();
    const revoked = await hostSpace.saveTeam({
      expectedRevision: 1,
      operation: "revokeInvite",
      key: `invitation:${secondId}`,
    });
    await hostSpace.close();
    host.forget();
    hostSpace = await host.open();
    expect(
      [...hostSpace.team.values()]
        .map(hostSpace.readTeam)
        .find((row) => row.key === `invitation:${secondId}`),
    ).toMatchObject({ status: "revoked", delivery: "local" });
    await host.refresh();
    const revokedSettled = hostSpace.executor.waitForTransactionCompletion(revoked.transactionId);
    host.reconnect();
    hostSpace.setAuthenticated(true);
    await revokedSettled;
    const staleSettled = recipientSpace.executor.waitForTransactionCompletion(stale.transactionId);
    recipient.reconnect();
    await expect(staleSettled).rejects.toThrow();
    expect(await recipientSpace.failedActions("team")).toMatchObject([
      { operation: "respond", code: "REVISION_CONFLICT" },
    ]);
    expect(
      await guest.query(api.projects.mine, { actorId: "guest", organizationId: guestOrg }),
    ).toEqual([]);
    await hostSpace.close();
    await recipientSpace.close();
    host.sqlite.close();
    recipient.sqlite.close();
  });
});
