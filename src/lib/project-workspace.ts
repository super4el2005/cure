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
  projectRoleSchema,
  projectValuesSchema,
  validateResearchTransition,
} from "@/src/lib/research-model";
import type { ProjectValues, ProjectRole } from "@/src/lib/research-model";
import { reportFailure } from "@/src/observability/events";

const rowSchema = projectValuesSchema.extend({
  clientId: z.uuid(),
  organizationId: z.string(),
  revision: z.number().int().positive(),
  selfRole: projectRoleSchema,
});
const envelopeSchema = z.object({
  clientId: z.uuid(),
  revision: z.number().int().positive(),
  ciphertext: z.string(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const failureSchema = z.object({
  id: z.string(),
  code: z.string(),
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
    const executor = startOfflineExecutor({
      collections: { [scope]: collection },
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
        "project.apply.v1": async (params) => {
          if (closed || !detector.isOnline()) throw new Error("AUTH_REQUIRED");
          try {
            await mutation(params);
          } catch (error) {
            if (!(error instanceof NonRetriableError)) {
              reportFailure(error, "projects.sync", "PROJECT_SYNC_UNCONFIRMED");
              // eslint-disable-next-line preserve-caught-error -- Provider payloads must not enter persistent errors.
              throw new Error("PROJECT_SYNC_UNCONFIRMED");
            }
            if (error.message.includes("UNAUTHENTICATED")) {
              detector.setAuthenticated(false);
              config.onAuthRequired();
              // eslint-disable-next-line preserve-caught-error -- The sanitized failure is reported centrally.
              throw new Error("AUTH_REQUIRED");
            }
            const code =
              [
                "ACCOUNT_CHANGED",
                "ACCESS_DENIED",
                "REVISION_CONFLICT",
                "INVALID_PROJECT",
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
                  envelope: change.modified,
                  at: Date.now(),
                }),
              );
            reportFailure(error, "projects.sync", code);
            throw new NonRetriableError(code);
          }
        },
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
    return {
      collection,
      executor,
      scope,
      organizationId: config.organizationId,
      role: config.role,
      expiresAt: config.expiresAt,
      setAuthenticated: (value: boolean) => detector.setAuthenticated(value),
      canWrite: () => executor.isOfflineEnabled,
      read(row: Envelope) {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        return read(row);
      },
      async save(command: Parameters<typeof apply>[0]) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        const tx = apply(command);
        const persisted = receipts.wait(tx.id);
        try {
          await Promise.race([persisted, tx.when("settled").then(() => undefined)]);
        } finally {
          receipts.cancel(tx.id);
        }
        void tx.when("settled").catch((error) => reportFailure(error, "projects.sync"));
        return { transactionId: tx.id };
      },
      async failedActions() {
        return Promise.all(
          (await failures.keys()).map(async (key) =>
            failureSchema.parse(JSON.parse((await failures.get(key))!)),
          ),
        );
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
          await collection.cleanup();
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
      await collection.cleanup();
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
