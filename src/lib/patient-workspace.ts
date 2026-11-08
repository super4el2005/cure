import {
  createBrowserWASQLitePersistence,
  BrowserCollectionCoordinator,
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
import { consentEventSchema, validateConsentTransition } from "@/src/lib/consent-model";
import type { ConsentEvent } from "@/src/lib/consent-model";
import { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import { openPatient, patientEnvelope, patientValueSchema } from "@/src/lib/patient-model";
import type { PatientEnvelope, PatientValues } from "@/src/lib/patient-model";
import { encryptedStorage } from "@/src/lib/patient-vault";
import type { Vault } from "@/src/lib/patient-vault";
export { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import { reportFailure } from "@/src/observability/events";

const failedActionSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    envelope: z.object({
      clientId: z.string(),
      revision: z.number(),
      deleted: z.boolean(),
      ciphertext: z.string(),
    }),
    action: z.enum(["create", "update", "delete"]),
    expectedRevision: z.number(),
    consent: consentEventSchema.optional(),
    consentId: z.uuid().optional(),
    at: z.number(),
  })
  .transform(({ consent, ...record }) => ({
    ...record,
    ...(record.consentId || consent ? { consentId: record.consentId ?? consent!.id } : {}),
  }));
export type FailedPatientAction = z.infer<typeof failedActionSchema>;

export async function openPatientWorkspace(config: {
  client: ConvexCollectionClient & Pick<ConvexReactClient, "mutation">;
  userId: string;
  organizationId: Id<"organizations">;
  role: "doctor" | "researcher";
  expiresAt: number;
  vault: Vault;
  persistence?: PersistedCollectionPersistence;
  storage?: StorageAdapter;
  failureStorage?: StorageAdapter;
  metadataStorage?: StorageAdapter;
  onlineDetector?: OnlineDetector;
  leaderElection?: LeaderElection;
  signal?: AbortSignal;
  onAuthRequired: () => void;
}) {
  if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
  const scope = `cure-patients-v1:${config.userId}:${config.organizationId}:${config.role}`;
  let database: BrowserWASQLiteDatabase | undefined;
  let coordinator: BrowserCollectionCoordinator | undefined;
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
        query: api.patients.list,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        select: (rows) => rows.map((row) => patientEnvelope(row, config.vault, scope)),
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "patients.sync"),
      }),
      persistence,
      schemaVersion: 1,
    }),
  );
  let cleanupExecutor: (() => void) | undefined;
  try {
    const outbox = encryptedStorage(
      config.storage ?? new IndexedDBAdapter(`${scope}:outbox`),
      config.vault,
      scope,
    );
    const failures = encryptedStorage(
      config.failureStorage ?? new IndexedDBAdapter(`${scope}:failures`),
      config.vault,
      `${scope}:failures`,
    );
    const metadata = encryptedStorage(
      config.metadataStorage ?? new IndexedDBAdapter(`${scope}:metadata`),
      config.vault,
      `${scope}:metadata`,
    );
    const receipts = durabilityReceipts(outbox);
    const detector = authenticatedDetector(
      config.onlineDetector ?? new WebOnlineDetector(),
      config.expiresAt,
    );
    let closed = false;
    // Probe the explicitly selected durable store. No silent online-only fallback.
    await outbox.set("storage-probe", "ok");
    if ((await outbox.get("storage-probe")) !== "ok") throw new Error("STORAGE_UNAVAILABLE");
    await outbox.delete("storage-probe");
    const mutation = convexOfflineMutation({
      client: config.client,
      mutation: api.patients.apply,
      collections: [collection],
      getArgs: ({ transaction }) => {
        if (transaction.mutations.length !== 1)
          throw new NonRetriableError("INVALID_PATIENT_OPERATION");
        const change = transaction.mutations[0]!;
        const row = (
          change.type === "delete" ? change.original : change.modified
        ) as PatientEnvelope;
        const decoded = openPatient(row, config.vault, scope);
        return {
          actorId: config.userId,
          organizationId: config.organizationId,
          clientId: decoded.clientId,
          action:
            change.type === "insert"
              ? ("create" as const)
              : change.type === "delete"
                ? ("delete" as const)
                : ("update" as const),
          expectedRevision:
            change.type === "insert" ? 0 : (change.original as PatientEnvelope).revision,
          ...(change.type === "delete" ? {} : { values: patientValueSchema.parse(decoded) }),
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
        "patient.apply.v1": async (params) => {
          if (closed || !detector.isOnline()) throw new Error("AUTH_REQUIRED");
          try {
            await mutation(params);
          } catch (error) {
            if (!(error instanceof NonRetriableError)) {
              reportFailure(error, "patients.sync", "PATIENT_SYNC_UNCONFIRMED");
              // eslint-disable-next-line preserve-caught-error -- Provider causes may contain patient data; the scrubbed stack is reported above.
              throw new Error("PATIENT_SYNC_UNCONFIRMED");
            }
            const message = error instanceof Error ? error.message : "";
            if (message.includes("UNAUTHENTICATED")) {
              detector.requireAuthentication();
              config.onAuthRequired();
              // eslint-disable-next-line preserve-caught-error -- Raw SDK causes must not enter persisted errors or console output.
              throw new Error("AUTH_REQUIRED");
            }
            const code =
              [
                "REVISION_CONFLICT",
                "ACCESS_DENIED",
                "INVALID_PATIENT",
                "IDEMPOTENCY_KEY_REUSED",
                "INVALID_CONSENT",
                "CONSENT_EXPIRED",
                "CONSENT_HISTORY_IMMUTABLE",
                "INVALID_CONSENT_RECIPIENT",
              ].find((c) => new RegExp(`\\b${c}\\b`).test(message)) ?? "PATIENT_SYNC_REJECTED";
            const change = params.transaction.mutations[0];
            let consentChange: ConsentEvent | undefined;
            if (change?.type === "update") {
              const original = openPatient(change.original as PatientEnvelope, config.vault, scope);
              const modified = openPatient(change.modified as PatientEnvelope, config.vault, scope);
              if (modified.consentHistory.length === original.consentHistory.length + 1)
                consentChange = modified.consentHistory.at(-1);
            }
            if (change)
              await failures.set(
                params.idempotencyKey,
                JSON.stringify({
                  id: params.idempotencyKey,
                  code,
                  envelope: change.type === "delete" ? change.original : change.modified,
                  action:
                    change.type === "insert"
                      ? ("create" as const)
                      : change.type === "delete"
                        ? ("delete" as const)
                        : ("update" as const),
                  expectedRevision:
                    change.type === "insert" ? 0 : (change.original as PatientEnvelope).revision,
                  ...(consentChange ? { consentId: consentChange.id } : {}),
                  at: Date.now(),
                }),
              );
            reportFailure(error, "patients.sync", code);
            throw new NonRetriableError(code);
          }
        },
      },
      shouldRetry: (error) => (error.message === "AUTH_REQUIRED" ? true : undefined),
      onStorageFailure: () => reportFailure(new Error("STORAGE_UNAVAILABLE"), "patients.queue"),
    });
    cleanupExecutor = () => executor.dispose();
    await executor.waitForInit();
    if (executor.mode !== "offline") throw new Error("STORAGE_UNAVAILABLE");
    const apply = executor.createOfflineAction<{
      expectedRevision: number;
      action: "create" | "update" | "delete" | "consent";
      clientId: string;
      values?: PatientValues;
      consent?: ConsentEvent;
    }>({
      mutationFnName: "patient.apply.v1",
      onMutate: (command) => {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (config.role !== "doctor") throw new Error("ACCESS_DENIED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const previous = collection.get(command.clientId);
        if ((previous?.revision ?? 0) !== command.expectedRevision)
          throw new Error("REVISION_CONFLICT");
        if (command.action === "create") {
          const values = patientValueSchema.parse(command.values);
          collection.insert(
            patientEnvelope(
              {
                ...values,
                clientId: command.clientId,
                revision: 1,
                deleted: false,
                updatedAt: Date.now(),
              },
              config.vault,
              scope,
            ),
          );
        } else {
          if (!previous || previous.deleted) throw new Error("PATIENT_NOT_FOUND");
          if (command.action === "delete") collection.delete(command.clientId);
          else {
            const prior = openPatient(previous, config.vault, scope);
            const values =
              command.action === "consent"
                ? {
                    ...prior,
                    consentHistory: [
                      ...prior.consentHistory,
                      consentEventSchema.parse(command.consent),
                    ],
                  }
                : {
                    ...patientValueSchema.parse(command.values),
                    consentHistory: prior.consentHistory,
                  };
            if (command.action === "consent")
              validateConsentTransition(
                prior.consentHistory,
                values.consentHistory,
                config.userId,
                Date.now(),
              );
            const envelope = patientEnvelope(
              {
                ...values,
                clientId: command.clientId,
                revision: previous.revision + 1,
                deleted: false,
                updatedAt: Date.now(),
              },
              config.vault,
              scope,
            );
            collection.update(command.clientId, (draft) => Object.assign(draft, envelope));
          }
        }
      },
    });
    return {
      collection,
      executor,
      scope,
      organizationId: config.organizationId,
      role: config.role,
      canWrite: () => executor.isOfflineEnabled,
      expiresAt: config.expiresAt,
      setAuthenticated: (value: boolean) => detector.setAuthenticated(value),
      confirmAuthentication: () => detector.confirmAuthentication(),
      requiresAuthentication: () => detector.requiresAuthentication(),
      read: (row: PatientEnvelope) => {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const decoded = openPatient(row, config.vault, scope);
        if (
          config.role === "researcher" &&
          (!decoded.consentApproved ||
            !decoded.accessExpiresAt ||
            decoded.accessExpiresAt <= Date.now())
        )
          throw new Error("ACCESS_DENIED");
        return decoded;
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
        void tx.when("settled").catch((error) => reportFailure(error, "patients.sync"));
        return { transactionId: tx.id };
      },
      async cacheResearchers(rows: { userId: string; displayName: string }[]) {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        const data = z
          .array(z.object({ userId: z.string(), displayName: z.string() }))
          .max(10000)
          .parse(rows);
        await metadata.set("researchers", JSON.stringify(data));
      },
      async cachedResearchers() {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const value = await metadata.get("researchers");
        return z
          .array(z.object({ userId: z.string(), displayName: z.string() }))
          .parse(value ? JSON.parse(value) : []);
      },
      async failedActions() {
        return Promise.all(
          (await failures.keys()).map(async (key) =>
            failedActionSchema.parse(JSON.parse((await failures.get(key))!)),
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
          reportFailure(error, "patients.close");
        }
        coordinator?.dispose();
        try {
          await database?.close?.();
        } catch (error) {
          reportFailure(error, "patients.close");
        }
      },
    };
  } catch (error) {
    config.vault.lock();
    cleanupExecutor?.();
    try {
      await collection.cleanup();
    } catch (cleanupError) {
      reportFailure(cleanupError, "patients.close");
    }
    coordinator?.dispose();
    try {
      await database?.close?.();
    } catch (cleanupError) {
      reportFailure(cleanupError, "patients.close");
    }
    throw error;
  }
}
