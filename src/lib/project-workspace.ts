import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import type {
  BrowserWASQLiteDatabase,
  PersistedCollectionPersistence,
} from "@tanstack/browser-db-sqlite-persistence";
import { convexCollectionOptions } from "@tanstack/convex-db-collection";
import type { ConvexCollectionClient } from "@tanstack/convex-db-collection";
import { convexMutationCodec, convexOfflineMutation } from "@tanstack/convex-db-collection/offline";
import { createCollection } from "@tanstack/db";
import {
  IndexedDBAdapter,
  NonRetriableError,
  startOfflineExecutor,
  WebOnlineDetector,
  WebLocksLeader,
  BroadcastChannelLeader,
} from "@tanstack/offline-transactions";
import type {
  StorageAdapter,
  OnlineDetector,
  LeaderElection,
} from "@tanstack/offline-transactions";
import type { ConvexReactClient } from "convex/react";
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import { encryptedStorage } from "@/src/lib/patient-vault";
import type { Vault } from "@/src/lib/patient-vault";
import {
  protocolValuesSchema,
  projectRoleSchema,
  projectValuesSchema,
  validateResearchTransition,
} from "@/src/lib/research-model";
import type { ProtocolValues, ProjectValues, ProjectRole } from "@/src/lib/research-model";
import { teamRecordSchema, teamCommandSchema, teamOperationSchema } from "@/src/lib/team-model";
import type { TeamRecord, TeamCommand, TeamOperation } from "@/src/lib/team-model";
import { reportFailure } from "@/src/observability/events";

const rowSchema = projectValuesSchema.extend({
  clientId: z.uuid(),
  organizationId: z.string(),
  revision: z.number().int().positive(),
  selfRole: projectRoleSchema,
});
const protocolRowSchema = protocolValuesSchema.extend({
  clientId: z.uuid(),
  projectClientId: z.uuid(),
  version: z.number().int().positive(),
});
const envelopeSchema = z.object({
  clientId: z.string().min(1),
  revision: z.number().int().positive(),
  ciphertext: z.string(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const failureSchema = z.object({
  id: z.string(),
  code: z.string(),
  domain: z.enum(["project", "protocol", "team"]).default("project"),
  operation: teamOperationSchema.optional(),
  envelope: envelopeSchema,
  at: z.number(),
});
export type FailedProjectAction = z.infer<typeof failureSchema>;

export async function openProjectWorkspace(config: {
  client: ConvexCollectionClient & Pick<ConvexReactClient, "mutation">;
  userId: string;
  organizationId: Id<"organizations">;
  role: "doctor" | "researcher";
  expiresAt: number;
  vault: Vault;
  signal?: AbortSignal;
  persistence?: PersistedCollectionPersistence;
  storage?: StorageAdapter;
  failureStorage?: StorageAdapter;
  onlineDetector?: OnlineDetector;
  leaderElection?: LeaderElection;
  onAuthRequired: () => void;
}) {
  if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
  const scope = `cure-projects-v1:${config.userId}:${config.organizationId}:${config.role}`;
  let database: BrowserWASQLiteDatabase | undefined;
  let coordinator: BrowserCollectionCoordinator | undefined;
  const read = (row: Envelope) => {
    const value = rowSchema.parse(config.vault.open(row.ciphertext, `${scope}:${row.clientId}`));
    if (value.clientId !== row.clientId || value.revision !== row.revision)
      throw new Error("INVALID_VAULT_DATA");
    return value;
  };
  const seal = (value: z.infer<typeof rowSchema>): Envelope => ({
    clientId: value.clientId,
    revision: value.revision,
    ciphertext: config.vault.seal(value, `${scope}:${value.clientId}`),
  });
  const protocolScope = `${scope}:protocols`;
  const readProtocol = (row: Envelope) => {
    const decoded = protocolRowSchema.parse(
      config.vault.open(row.ciphertext, `${protocolScope}:${row.clientId}`),
    );
    if (decoded.clientId !== row.clientId || decoded.version !== row.revision)
      throw new Error("INVALID_VAULT_DATA");
    return decoded;
  };
  const sealProtocol = (row: z.infer<typeof protocolRowSchema>): Envelope => ({
    clientId: row.clientId,
    revision: row.version,
    ciphertext: config.vault.seal(row, `${protocolScope}:${row.clientId}`),
  });
  const teamScope = `${scope}:team`;
  const readTeam = (envelope: Envelope) => {
    const row = teamRecordSchema.parse(
      config.vault.open(envelope.ciphertext, `${teamScope}:${envelope.clientId}`),
    );
    if (row.key !== envelope.clientId || row.revision !== envelope.revision)
      throw new Error("INVALID_VAULT_DATA");
    return row;
  };
  const sealTeam = (row: TeamRecord): Envelope => ({
    clientId: row.key,
    revision: row.revision,
    ciphertext: config.vault.seal(row, `${teamScope}:${row.key}`),
  });
  let persistence = config.persistence;
  if (!persistence) {
    database = await openBrowserWASQLiteOPFSDatabase({
      databaseName: scope,
      ...(config.signal ? { signal: config.signal } : {}),
    });
    coordinator = new BrowserCollectionCoordinator({ dbName: scope });
    persistence = createBrowserWASQLitePersistence({
      database,
      coordinator,
      schemaMismatchPolicy: "throw",
    });
  }
  const collection = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: scope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.projects.mine,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        select: (rows) => rows.map((row) => seal(rowSchema.parse(row))),
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "projects.sync"),
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  const protocols = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: protocolScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.protocols.mine,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        select: (rows) => rows.map((row) => sealProtocol(protocolRowSchema.parse(row))),
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "projects.sync"),
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  const team = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: teamScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.projectTeams.workspace,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        select: (rows) => rows.map((row) => sealTeam(teamRecordSchema.parse(row))),
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "projects.sync"),
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  let disposeExecutor: (() => void) | undefined;
  try {
    const storage = encryptedStorage(
      config.storage ?? new IndexedDBAdapter(`${scope}:outbox`),
      config.vault,
      scope,
    );
    const failures = encryptedStorage(
      config.failureStorage ?? new IndexedDBAdapter(`${scope}:failures`),
      config.vault,
      `${scope}:failures`,
    );
    await storage.set("probe", "ok");
    if ((await storage.get("probe")) !== "ok") throw new Error("STORAGE_UNAVAILABLE");
    await storage.delete("probe");
    const receipts = durabilityReceipts(storage);
    const detector = authenticatedDetector(
      config.onlineDetector ?? new WebOnlineDetector(),
      config.expiresAt,
    );
    let closed = false;
    const mutation = convexOfflineMutation({
      client: config.client,
      mutation: api.projects.apply,
      collections: [collection],
      getArgs: ({ transaction }) => {
        if (transaction.mutations.length !== 1 || transaction.mutations[0]!.type === "delete")
          throw new NonRetriableError("INVALID_PROJECT");
        const change = transaction.mutations[0]!;
        const row = read(change.modified as Envelope);
        return {
          actorId: config.userId,
          organizationId: row.organizationId as Id<"organizations">,
          clientId: row.clientId,
          expectedRevision: change.type === "insert" ? 0 : (change.original as Envelope).revision,
          values: projectValuesSchema.parse(row),
        };
      },
    });
    const protocolMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.protocols.append,
      collections: [protocols],
      getArgs: ({ transaction }) => {
        if (transaction.mutations.length !== 1 || transaction.mutations[0]!.type !== "insert")
          throw new NonRetriableError("INVALID_PROTOCOL");
        const row = readProtocol(transaction.mutations[0]!.modified as Envelope);
        return {
          actorId: config.userId,
          clientId: row.clientId,
          projectClientId: row.projectClientId,
          expectedVersion: row.version - 1,
          values: protocolValuesSchema.parse(row),
        };
      },
    });
    const teamChange = (params: Parameters<typeof mutation>[0], operation: TeamOperation) => {
      if (params.transaction.mutations.length !== 1)
        throw new NonRetriableError("INVALID_TEAM_OPERATION");
      const change = params.transaction.mutations[0]!;
      if (change.type !== (operation === "invite" ? "insert" : "update"))
        throw new NonRetriableError("INVALID_TEAM_OPERATION");
      return {
        row: readTeam(change.modified as Envelope),
        previous: operation === "invite" ? undefined : readTeam(change.original as Envelope),
      };
    };
    const inviteMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.projectTeams.invite,
      collections: [team],
      getArgs: (params) => {
        const { row } = teamChange(params, "invite");
        if (row.entity !== "invitation" || !row.targetProfileId)
          throw new NonRetriableError("INVALID_TEAM_OPERATION");
        return {
          actorId: config.userId,
          projectClientId: row.projectClientId,
          clientId: row.clientId,
          targetProfileId: row.targetProfileId as Id<"profiles">,
          role: row.role,
        };
      },
    });
    const respondMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.projectTeams.respond,
      collections: [team],
      getArgs: (params) => {
        const { row, previous } = teamChange(params, "respond");
        if (
          row.entity !== "invitation" ||
          !previous ||
          !["accepted", "declined"].includes(row.status)
        )
          throw new NonRetriableError("INVALID_TEAM_OPERATION");
        return {
          actorId: config.userId,
          clientId: row.clientId,
          decision: row.status === "accepted" ? ("accept" as const) : ("decline" as const),
          organizationId: config.organizationId,
          expectedRevision: previous.revision,
        };
      },
    });
    const revokeMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.projectTeams.revokeInvite,
      collections: [team],
      getArgs: (params) => {
        const { row, previous } = teamChange(params, "revokeInvite");
        if (row.entity !== "invitation" || !previous)
          throw new NonRetriableError("INVALID_TEAM_OPERATION");
        return {
          actorId: config.userId,
          clientId: row.clientId,
          expectedRevision: previous.revision,
        };
      },
    });
    const memberMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.projectTeams.setMember,
      collections: [team],
      getArgs: (params) => {
        const { row, previous } = teamChange(params, "setMember");
        if (row.entity !== "member" || row.role === "owner" || !previous)
          throw new NonRetriableError("INVALID_TEAM_OPERATION");
        return {
          actorId: config.userId,
          projectClientId: row.projectClientId,
          targetUserId: row.userId,
          role: row.role,
          active: row.active,
          expectedRevision: previous.revision,
        };
      },
    });
    const guarded =
      (
        invoke: typeof mutation,
        domain: "project" | "protocol" | "team",
        operation?: TeamOperation,
      ) =>
      async (params: Parameters<typeof mutation>[0]) => {
        if (closed || !detector.isOnline()) throw new Error("AUTH_REQUIRED");
        try {
          await invoke(params);
        } catch (error) {
          if (!(error instanceof NonRetriableError)) {
            reportFailure(error, "projects.sync", "PROJECT_SYNC_UNCONFIRMED");
            // eslint-disable-next-line preserve-caught-error -- Provider payloads must not enter persistent errors.
            throw new Error("PROJECT_SYNC_UNCONFIRMED");
          }
          if (error.message.includes("UNAUTHENTICATED")) {
            detector.requireAuthentication();
            config.onAuthRequired();
            // eslint-disable-next-line preserve-caught-error -- The sanitized failure is reported centrally.
            throw new Error("AUTH_REQUIRED");
          }
          const code =
            [
              "INVALID_TEAM_OPERATION",
              "INVITEE_UNAVAILABLE",
              "ALREADY_MEMBER",
              "INVITE_ALREADY_PENDING",
              "INVITE_EXPIRED",
              "INVITE_NOT_PENDING",
              "AFFILIATION_REQUIRED",
              "NEW_INVITATION_REQUIRED",
              "ACCOUNT_CHANGED",
              "ACCESS_DENIED",
              "REVISION_CONFLICT",
              "INVALID_PROJECT",
              "INVALID_PROTOCOL",
              "PROJECT_COMPLETED",
              "IDEMPOTENCY_KEY_REUSED",
              "INVALID_RESEARCH_TRANSITION",
              "PROJECT_NOT_PUBLISHABLE",
              "ETHICS_APPROVAL_REQUIRED",
            ].find((code) => new RegExp(`\\b${code}\\b`).test(error.message)) ??
            "PROJECT_SYNC_REJECTED";
          const change = params.transaction.mutations[0];
          if (change)
            await failures.set(
              params.idempotencyKey,
              JSON.stringify({
                id: params.idempotencyKey,
                code,
                domain,
                ...(operation ? { operation } : {}),
                envelope: change.modified,
                at: Date.now(),
              }),
            );
          reportFailure(error, "projects.sync", code);
          throw new NonRetriableError(code);
        }
      };
    const executor = startOfflineExecutor({
      collections: { [scope]: collection, [protocolScope]: protocols, [teamScope]: team },
      storage: receipts.storage,
      mutationCodec: convexMutationCodec,
      onlineDetector: detector,
      leaderElection:
        config.leaderElection ??
        (typeof navigator !== "undefined" && navigator.locks
          ? new WebLocksLeader(`${scope}:leader`)
          : new BroadcastChannelLeader(`${scope}:leader`)),
      maxConcurrency: 1,
      mutationFns: {
        "project.apply.v1": guarded(mutation, "project"),
        "protocol.append.v1": guarded(protocolMutation, "protocol"),
        "team.invite.v1": guarded(inviteMutation, "team", "invite"),
        "team.respond.v1": guarded(respondMutation, "team", "respond"),
        "team.revokeInvite.v1": guarded(revokeMutation, "team", "revokeInvite"),
        "team.setMember.v1": guarded(memberMutation, "team", "setMember"),
      },
      shouldRetry: (error) => (error.message === "AUTH_REQUIRED" ? true : undefined),
      onStorageFailure: () => reportFailure(new Error("STORAGE_UNAVAILABLE"), "projects.queue"),
    });
    disposeExecutor = () => executor.dispose();
    await executor.waitForInit();
    if (executor.mode !== "offline") throw new Error("STORAGE_UNAVAILABLE");
    const apply = executor.createOfflineAction<{ clientId: string; values: ProjectValues }>({
      mutationFnName: "project.apply.v1",
      onMutate: (command) => {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const values = projectValuesSchema.parse(command.values);
        const previous = collection.get(command.clientId);
        if (previous) {
          const row = read(previous);
          if (!["owner", "coordinator"].includes(row.selfRole)) throw new Error("ACCESS_DENIED");
          validateResearchTransition(row.status, values.status, row.selfRole);
          collection.update(command.clientId, (draft) =>
            Object.assign(draft, seal({ ...row, ...values, revision: row.revision + 1 })),
          );
        } else {
          if (values.status !== "draft" || values.published)
            throw new Error("INVALID_RESEARCH_TRANSITION");
          collection.insert(
            seal(
              rowSchema.parse({
                ...values,
                clientId: command.clientId,
                revision: 1,
                organizationId: config.organizationId,
                selfRole: "owner" satisfies ProjectRole,
              }),
            ),
          );
        }
      },
    });
    const appendProtocol = executor.createOfflineAction<{
      clientId: string;
      projectClientId: string;
      values: ProtocolValues;
    }>({
      mutationFnName: "protocol.append.v1",
      onMutate: (command) => {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        if (protocols.status !== "ready") throw new Error("WORKSPACE_NOT_READY");
        const project = collection.get(command.projectClientId);
        const parent = project ? read(project) : undefined;
        if (!parent || !["owner", "coordinator"].includes(parent.selfRole))
          throw new Error("ACCESS_DENIED");
        if (["completed", "archived"].includes(parent.status)) throw new Error("PROJECT_COMPLETED");
        const values = protocolValuesSchema.parse(command.values);
        if (values.ethicsApproved && values.ethicsExpiresAt <= Date.now())
          throw new Error("ETHICS_APPROVAL_REQUIRED");
        const version =
          Array.from(protocols.values())
            .map(readProtocol)
            .reduce(
              (latest, row) =>
                row.projectClientId === command.projectClientId
                  ? Math.max(latest, row.version)
                  : latest,
              0,
            ) + 1;
        protocols.insert(
          sealProtocol(
            protocolRowSchema.parse({
              ...values,
              clientId: command.clientId,
              projectClientId: command.projectClientId,
              version,
            }),
          ),
        );
      },
    });
    const teamActions = Object.fromEntries(
      (["invite", "respond", "revokeInvite", "setMember"] as const).map((operation) => [
        operation,
        executor.createOfflineAction<TeamCommand>({
          mutationFnName: `team.${operation}.v1`,
          onMutate: (input) => {
            if (closed) throw new Error("WORKSPACE_LOCKED");
            if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
            if (team.status !== "ready") throw new Error("WORKSPACE_NOT_READY");
            const command = teamCommandSchema.parse(input);
            if (command.operation !== operation) throw new Error("INVALID_TEAM_OPERATION");
            if (command.operation === "invite") {
              const envelope = collection.get(command.projectClientId);
              const project = envelope ? read(envelope) : undefined;
              if (
                !project ||
                !["owner", "coordinator"].includes(project.selfRole) ||
                (command.role === "coordinator" && project.selfRole !== "owner")
              )
                throw new Error("ACCESS_DENIED");
              if (["completed", "archived"].includes(project.status))
                throw new Error("PROJECT_COMPLETED");
              team.insert(
                sealTeam({
                  entity: "invitation",
                  key: `invitation:${command.clientId}`,
                  clientId: command.clientId,
                  projectClientId: command.projectClientId,
                  inviteeId: "",
                  inviterId: config.userId,
                  targetProfileId: command.targetProfileId,
                  inviteeName: command.inviteeName,
                  projectTitle: project.title,
                  projectStatus: project.status,
                  role: command.role,
                  status: "pending",
                  expiresAt: Date.now() + 7 * 86400000,
                  revision: 1,
                  delivery: "local",
                }),
              );
              return;
            }
            const envelope = team.get(command.key);
            if (!envelope) throw new Error("INVALID_TEAM_OPERATION");
            const row = readTeam(envelope);
            const parent = collection.get(row.projectClientId);
            const project = parent ? read(parent) : undefined;
            if (command.operation === "respond") {
              if (row.entity !== "invitation" || row.inviteeId !== config.userId)
                throw new Error("ACCESS_DENIED");
              if (row.status !== "pending") throw new Error("INVITE_NOT_PENDING");
              if (
                command.decision === "accept" &&
                (row.expiresAt <= Date.now() ||
                  ["completed", "archived"].includes(row.projectStatus ?? "archived"))
              )
                throw new Error("INVITE_EXPIRED");
              team.update(row.key, (draft) =>
                Object.assign(
                  draft,
                  sealTeam({
                    ...row,
                    status: command.decision === "accept" ? "accepted" : "declined",
                    revision: row.revision + 1,
                    delivery: "local",
                  }),
                ),
              );
              return;
            }
            if (!project || !["owner", "coordinator"].includes(project.selfRole))
              throw new Error("ACCESS_DENIED");
            if (command.operation === "revokeInvite") {
              if (row.entity !== "invitation" || row.status !== "pending")
                throw new Error("INVITE_NOT_PENDING");
              if (row.role === "coordinator" && project.selfRole !== "owner")
                throw new Error("ACCESS_DENIED");
              team.update(row.key, (draft) =>
                Object.assign(
                  draft,
                  sealTeam({
                    ...row,
                    status: "revoked",
                    revision: row.revision + 1,
                    delivery: "local",
                  }),
                ),
              );
            } else {
              if (
                row.entity !== "member" ||
                row.role === "owner" ||
                (project.selfRole !== "owner" &&
                  (row.role === "coordinator" || command.role === "coordinator"))
              )
                throw new Error("ACCESS_DENIED");
              if (command.active && !row.active) throw new Error("NEW_INVITATION_REQUIRED");
              team.update(row.key, (draft) =>
                Object.assign(
                  draft,
                  sealTeam({
                    ...row,
                    role: command.role,
                    active: command.active,
                    revision: row.revision + 1,
                    delivery: "local",
                  }),
                ),
              );
            }
          },
        }),
      ]),
    );
    const saveTransaction = async (tx: ReturnType<typeof apply>) => {
      const persisted = receipts.wait(tx.id);
      try {
        await Promise.race([persisted, tx.when("settled").then(() => undefined)]);
      } finally {
        receipts.cancel(tx.id);
      }
      void tx.when("settled").catch((error) => reportFailure(error, "projects.sync"));
      return { transactionId: tx.id };
    };
    return {
      collection,
      protocols,
      team,
      executor,
      scope,
      organizationId: config.organizationId,
      role: config.role,
      expiresAt: config.expiresAt,
      setAuthenticated: (value: boolean) => detector.setAuthenticated(value),
      confirmAuthentication: () => detector.confirmAuthentication(),
      requiresAuthentication: () => detector.requiresAuthentication(),
      canWrite: () => executor.isOfflineEnabled,
      read(row: Envelope) {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        return read(row);
      },
      readProtocol(row: Envelope) {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        return readProtocol(row);
      },
      readTeam(row: Envelope) {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        return readTeam(row);
      },
      async saveTeam(command: TeamCommand) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        const parsed = teamCommandSchema.parse(command);
        return saveTransaction(teamActions[parsed.operation]!(parsed));
      },
      async save(command: Parameters<typeof apply>[0]) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        return saveTransaction(apply(command));
      },
      async saveProtocol(command: Parameters<typeof appendProtocol>[0]) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        return saveTransaction(appendProtocol(command));
      },
      async failedActions(domain: "project" | "protocol" | "team" = "project") {
        const rows = await Promise.all(
          (await failures.keys()).map(async (key) =>
            failureSchema.parse(JSON.parse((await failures.get(key))!)),
          ),
        );
        return rows.filter((row) => row.domain === domain);
      },
      async dismissFailure(id: string) {
        await failures.delete(id);
      },
      async close() {
        if (closed) return;
        closed = true;
        config.vault.lock();
        detector.setAuthenticated(false);
        executor.dispose();
        receipts.dispose();
        try {
          await Promise.all([collection.cleanup(), protocols.cleanup(), team.cleanup()]);
        } catch (error) {
          reportFailure(error, "projects.close");
        }
        coordinator?.dispose();
        try {
          await database?.close?.();
        } catch (error) {
          reportFailure(error, "projects.close");
        }
      },
    };
  } catch (error) {
    config.vault.lock();
    disposeExecutor?.();
    try {
      await Promise.all([collection.cleanup(), protocols.cleanup(), team.cleanup()]);
    } catch (cleanupError) {
      reportFailure(cleanupError, "projects.close");
    }
    coordinator?.dispose();
    try {
      await database?.close?.();
    } catch (cleanupError) {
      reportFailure(cleanupError, "projects.close");
    }
    throw error;
  }
}
