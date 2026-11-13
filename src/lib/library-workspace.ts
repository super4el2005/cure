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
  BroadcastChannelLeader,
  IndexedDBAdapter,
  NonRetriableError,
  startOfflineExecutor,
  WebLocksLeader,
  WebOnlineDetector,
} from "@tanstack/offline-transactions";
import type {
  StorageAdapter,
  OnlineDetector,
  LeaderElection,
} from "@tanstack/offline-transactions";
import type { ConvexReactClient } from "convex/react";
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import {
  libraryEntrySchema,
  readLibrary,
  readLibraryVersion,
  sealLibrary,
  sealLibraryVersion,
} from "@/src/lib/library-model";
import type { LibraryCommand } from "@/src/lib/library-model";
import { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import type { PatientEnvelope } from "@/src/lib/patient-model";
import { encryptedStorage } from "@/src/lib/patient-vault";
import type { Vault } from "@/src/lib/patient-vault";
import { reportFailure } from "@/src/observability/events";

const failureSchema = z.object({
  id: z.string(),
  code: z.string(),
  action: z.enum(["create", "update", "delete"]),
  expectedRevision: z.number(),
  envelope: z.object({
    clientId: z.string(),
    revision: z.number(),
    deleted: z.boolean(),
    ciphertext: z.string(),
  }),
  at: z.number(),
});
export type FailedLibraryAction = z.infer<typeof failureSchema>;
export async function openLibraryWorkspace(config: {
  client: ConvexCollectionClient & Pick<ConvexReactClient, "mutation">;
  userId: string;
  expiresAt: number;
  vault: Vault;
  persistence?: PersistedCollectionPersistence;
  storage?: StorageAdapter;
  failureStorage?: StorageAdapter;
  onlineDetector?: OnlineDetector;
  leaderElection?: LeaderElection;
  signal?: AbortSignal;
  onAuthRequired: () => void;
}) {
  if (Date.now() >= config.expiresAt) {
    config.vault.lock();
    throw new Error("OFFLINE_ACCESS_EXPIRED");
  }
  const scope = `cure-library-v1:${config.userId}`;
  const versionScope = `${scope}:versions`;
  let database: BrowserWASQLiteDatabase | undefined;
  let coordinator: BrowserCollectionCoordinator | undefined;
  let persistence = config.persistence;
  try {
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
  } catch (error) {
    config.vault.lock();
    coordinator?.dispose();
    try {
      await database?.close?.();
    } catch (closeError) {
      reportFailure(closeError, "library.close");
    }
    throw error;
  }
  const snapshotId = "__library_snapshot__";
  const versionSnapshotId = "__library_versions_snapshot__";
  const marker = (id: string, namespace: string): PatientEnvelope => ({
    clientId: id,
    revision: 1,
    deleted: false,
    ciphertext: config.vault.seal({ prepared: true }, `${namespace}:snapshot`),
  });
  const collection = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: scope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.library.list,
        queryArgs: { actorId: config.userId },
        select: (rows) => [
          marker(snapshotId, scope),
          ...rows.map((row) => sealLibrary(row, config.vault, scope)),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "library.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  const versions = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: versionScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.library.versions,
        queryArgs: { actorId: config.userId },
        select: (rows) => [
          marker(versionSnapshotId, versionScope),
          ...rows.map((row) =>
            sealLibraryVersion({ ...row, confirmed: true }, config.vault, versionScope),
          ),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "library.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  let disposeExecutor: (() => void) | undefined;
  let disposeReceipts: (() => void) | undefined;
  let closed = false;
  const assertOpen = () => {
    if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
  };
  try {
    const failures = encryptedStorage(
      config.failureStorage ?? new IndexedDBAdapter(`${scope}:failures`),
      config.vault,
      `${scope}:failures`,
    );
    const receipts = durabilityReceipts(
      encryptedStorage(
        config.storage ?? new IndexedDBAdapter(`${scope}:outbox`),
        config.vault,
        scope,
      ),
    );
    disposeReceipts = () => receipts.dispose();
    const detector = authenticatedDetector(
      config.onlineDetector ?? new WebOnlineDetector(),
      config.expiresAt,
    );
    const mutation = convexOfflineMutation({
      client: config.client,
      mutation: api.library.apply,
      collections: [collection, versions],
      getArgs: ({ transaction }) => {
        const changes = transaction.mutations.filter((change) => change.collection.id === scope);
        if (changes.length !== 1 || changes[0]!.type === "delete")
          throw new NonRetriableError("INVALID_LIBRARY");
        const change = changes[0]!;
        const row = readLibrary(change.modified as PatientEnvelope, config.vault, scope);
        const previous =
          change.type === "insert"
            ? null
            : readLibrary(change.original as PatientEnvelope, config.vault, scope);
        const archive = transaction.mutations.filter((item) => item.collection.id === versionScope);
        if (
          transaction.mutations.length !== (row.deleted ? 1 : 2) ||
          archive.length !== (row.deleted ? 0 : 1)
        )
          throw new NonRetriableError("INVALID_LIBRARY");
        if (!row.deleted) {
          const version = readLibraryVersion(
            archive[0]!.modified as PatientEnvelope,
            config.vault,
            versionScope,
          );
          if (
            archive[0]!.type !== "insert" ||
            version.clientId !== row.writeId ||
            version.itemClientId !== row.clientId ||
            version.revision !== row.revision ||
            JSON.stringify(version.entry) !== JSON.stringify(row.entry)
          )
            throw new NonRetriableError("INVALID_LIBRARY");
        }
        return {
          actorId: config.userId,
          clientId: row.clientId,
          writeId: row.writeId,
          expectedWriteId: previous?.writeId ?? null,
          expectedRevision: previous?.revision ?? 0,
          action:
            change.type === "insert"
              ? ("create" as const)
              : row.deleted
                ? ("delete" as const)
                : ("update" as const),
          ...(row.entry ? { entry: row.entry } : {}),
        };
      },
    });
    const guarded: typeof mutation = async (params) => {
      try {
        await mutation(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("UNAUTHENTICATED")) {
          detector.requireAuthentication();
          config.onAuthRequired();
          // eslint-disable-next-line preserve-caught-error -- SDK causes may contain request values and must not enter queue diagnostics.
          throw new Error("AUTH_REQUIRED");
        }
        const code = [
          "ACCOUNT_CHANGED",
          "PROFILE_REQUIRED",
          "ACCESS_DENIED",
          "INVALID_LIBRARY",
          "REVISION_CONFLICT",
          "IDEMPOTENCY_KEY_REUSED",
          "INVALID_REQUEST",
        ].find((value) => new RegExp(`\\b${value}\\b`).test(message));
        if (!code) throw error;
        const change = params.transaction.mutations.find((item) => item.collection.id === scope);
        if (change)
          await failures.set(
            params.transaction.id,
            JSON.stringify({
              id: params.transaction.id,
              code,
              action:
                change.type === "insert"
                  ? "create"
                  : (change.modified as PatientEnvelope).deleted
                    ? "delete"
                    : "update",
              expectedRevision:
                change.type === "insert" ? 0 : (change.original as PatientEnvelope).revision,
              envelope: change.modified,
              at: Date.now(),
            }),
          );
        reportFailure(new Error(code), "library.sync", code);
        throw new NonRetriableError(code);
      }
    };
    const executor = startOfflineExecutor({
      collections: { [scope]: collection, [versionScope]: versions },
      storage: receipts.storage,
      mutationCodec: convexMutationCodec,
      onlineDetector: detector,
      leaderElection:
        config.leaderElection ??
        (typeof navigator !== "undefined" && navigator.locks
          ? new WebLocksLeader(`${scope}:leader`)
          : new BroadcastChannelLeader(`${scope}:leader`)),
      maxConcurrency: 1,
      mutationFns: { "library.apply.v1": guarded },
      shouldRetry: (error) => (error.message === "AUTH_REQUIRED" ? true : undefined),
      onStorageFailure: () => reportFailure(new Error("STORAGE_UNAVAILABLE"), "library.queue"),
    });
    disposeExecutor = () => executor.dispose();
    await executor.waitForInit();
    if (executor.mode !== "offline") throw new Error("STORAGE_UNAVAILABLE");
    if (config.signal?.aborted) throw new Error("CANCELLED");
    const apply = executor.createOfflineAction<LibraryCommand>({
      mutationFnName: "library.apply.v1",
      onMutate: (command) => {
        assertOpen();
        const envelope = collection.get(command.clientId);
        const previous = envelope ? readLibrary(envelope, config.vault, scope) : null;
        if (
          (previous?.revision ?? 0) !== command.expectedRevision ||
          (command.action === "create" ? Boolean(previous) : !previous || previous.deleted)
        )
          throw new Error("REVISION_CONFLICT");
        const now = Date.now();
        const writeId = crypto.randomUUID();
        const revision = command.expectedRevision + 1;
        const entry = command.action === "delete" ? null : libraryEntrySchema.parse(command.entry);
        const row = sealLibrary(
          {
            clientId: command.clientId,
            writeId,
            revision,
            deleted: command.action === "delete",
            entry,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          },
          config.vault,
          scope,
        );
        if (previous) collection.update(command.clientId, (draft) => Object.assign(draft, row));
        else collection.insert(row);
        if (entry)
          versions.insert(
            sealLibraryVersion(
              {
                clientId: writeId,
                itemClientId: command.clientId,
                revision,
                entry,
                recordedAt: now,
                recordedBy: config.userId,
              },
              config.vault,
              versionScope,
            ),
          );
      },
    });
    return {
      scope,
      purpose: "library" as const,
      collection,
      versions,
      snapshotId,
      versionSnapshotId,
      executor,
      expiresAt: config.expiresAt,
      canWrite: () => executor.isOfflineEnabled,
      setAuthenticated: (value: boolean) => detector.setAuthenticated(value),
      confirmAuthentication: () => detector.confirmAuthentication(),
      requiresAuthentication: () => detector.requiresAuthentication(),
      read: (envelope: PatientEnvelope) => {
        assertOpen();
        return readLibrary(envelope, config.vault, scope);
      },
      readVersion: (envelope: PatientEnvelope) => {
        assertOpen();
        const row = readLibraryVersion(envelope, config.vault, versionScope);
        const parent = collection.get(row.itemClientId);
        if (!parent || parent.deleted) throw new Error("LIBRARY_ITEM_DELETED");
        return row;
      },
      async save(command: LibraryCommand) {
        assertOpen();
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        const tx = apply(command);
        const persisted = receipts.wait(tx.id);
        try {
          await Promise.race([persisted, tx.when("settled").then(() => undefined)]);
        } finally {
          receipts.cancel(tx.id);
        }
        void tx.when("settled").catch((error) => reportFailure(error, "library.sync"));
        return { transactionId: tx.id };
      },
      async failedActions() {
        assertOpen();
        return Promise.all(
          (await failures.keys()).map(async (key) =>
            failureSchema.parse(JSON.parse((await failures.get(key))!)),
          ),
        );
      },
      async dismissFailure(id: string) {
        assertOpen();
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
          await Promise.all([collection.cleanup(), versions.cleanup()]);
        } catch (error) {
          reportFailure(error, "library.close");
        }
        coordinator?.dispose();
        try {
          await database?.close?.();
        } catch (error) {
          reportFailure(error, "library.close");
        }
      },
    };
  } catch (error) {
    closed = true;
    config.vault.lock();
    disposeExecutor?.();
    disposeReceipts?.();
    try {
      await Promise.all([collection.cleanup(), versions.cleanup()]);
    } catch (cleanupError) {
      reportFailure(cleanupError, "library.close");
    }
    coordinator?.dispose();
    await database?.close?.();
    throw error;
  }
}
