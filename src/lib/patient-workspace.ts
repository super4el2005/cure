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
import {
  clinicalEnvelope,
  hasClinicalWriteId,
  openClinicalRecord,
  clinicalPayloadSchema,
  validateClinicalTransition,
} from "@/src/lib/clinical-record-model";
import type { ClinicalCommand, ClinicalEnvelope } from "@/src/lib/clinical-record-model";
import {
  clinicalVersionSchema,
  legacyClinicalVersionId,
  openClinicalVersion,
  sealClinicalVersion,
} from "@/src/lib/clinical-version-model";
import { consentEventSchema, validateConsentTransition } from "@/src/lib/consent-model";
import type { ConsentEvent } from "@/src/lib/consent-model";
import { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import { openPatient, patientEnvelope, patientValueSchema } from "@/src/lib/patient-model";
import type { PatientEnvelope, PatientValues } from "@/src/lib/patient-model";
import { encryptedStorage } from "@/src/lib/patient-vault";
import type { Vault } from "@/src/lib/patient-vault";
import {
  legacyPatientVersionId,
  patientVersionSchema,
  patientVersionValuesSchema,
  openPatientVersion,
  sealPatientVersion,
} from "@/src/lib/patient-version-model";
import { analysisValuesSchema, readAnalysis, sealAnalysis } from "@/src/lib/saved-analysis-model";
import type { AnalysisCommand } from "@/src/lib/saved-analysis-model";
import { validateEnrollmentChange } from "@/src/lib/study-enrollment-model";
import { validateStudyIssueWrite } from "@/src/lib/study-issue-model";
import {
  studyVisitNeedsAuthorization,
  validateStudyVisitParticipation,
} from "@/src/lib/study-visit-model";
export { authenticatedDetector, durabilityReceipts } from "@/src/lib/offline-admission";
import { reportFailure } from "@/src/observability/events";

const failedActionSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    domain: z.enum(["patient", "clinical", "analysis"]).default("patient"),
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
  const patientSnapshotId = "__patient_snapshot__";
  const collection = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: scope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.patients.list,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        select: (rows) => [
          {
            clientId: patientSnapshotId,
            revision: 1,
            deleted: false,
            ciphertext: config.vault.seal({ prepared: true }, `${scope}:snapshot`),
          },
          ...rows.map((row) => patientEnvelope(row, config.vault, scope)),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "patients.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  const patientVersionScope = `${scope}:patientVersions`;
  const patientVersionSnapshotId = "__patient_versions_snapshot__";
  const patientVersions = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: patientVersionScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.patients.versions,
        queryArgs: { actorId: config.userId, organizationId: config.organizationId },
        select: (rows) => [
          {
            clientId: patientVersionSnapshotId,
            revision: 1,
            deleted: false,
            ciphertext: config.vault.seal({ prepared: true }, `${patientVersionScope}:snapshot`),
          },
          ...rows.map((row) =>
            sealPatientVersion(patientVersionSchema.parse(row), config.vault, patientVersionScope),
          ),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "patients.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  const clinicalScope = `${scope}:clinical`;
  const snapshotId = "__clinical_snapshot__";
  const clinicalRecords = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: clinicalScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.clinicalRecords.list,
        queryArgs: { organizationId: config.organizationId, actorId: config.userId },
        // Retain evidence of a confirmed empty snapshot as well. Otherwise an empty
        // RC persistence cache cannot distinguish preparation from no data offline.
        select: (rows) => [
          {
            clientId: snapshotId,
            revision: 1,
            deleted: false,
            ciphertext: config.vault.seal({ prepared: true }, `${clinicalScope}:snapshot`),
          },
          ...rows.map((row) => clinicalEnvelope(row, config.vault, clinicalScope)),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "clinical.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  const versionScope = `${scope}:clinicalVersions`;
  const versionSnapshotId = "__clinical_versions_snapshot__";
  const clinicalVersions = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: versionScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.clinicalRecords.versions,
        queryArgs: { actorId: config.userId, organizationId: config.organizationId },
        select: (rows) => [
          {
            clientId: versionSnapshotId,
            revision: 1,
            deleted: false,
            ciphertext: config.vault.seal({ prepared: true }, `${versionScope}:snapshot`),
          },
          ...rows.map((row) =>
            sealClinicalVersion(clinicalVersionSchema.parse(row), config.vault, versionScope),
          ),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "clinical.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
    }),
  );
  const analysisScope = `${scope}:analyses`;
  const analysisSnapshotId = "__analysis_snapshot__";
  const analyses = createCollection(
    persistedCollectionOptions({
      ...convexCollectionOptions({
        id: analysisScope,
        startSync: true,
        gcTime: Infinity,
        client: config.client,
        query: api.analyses.list,
        queryArgs: { actorId: config.userId, organizationId: config.organizationId },
        select: (rows) => [
          {
            clientId: analysisSnapshotId,
            revision: 1,
            deleted: false,
            ciphertext: config.vault.seal({ prepared: true }, `${analysisScope}:snapshot`),
          },
          ...rows.map((row) => sealAnalysis(row, config.vault, analysisScope)),
        ],
        getKey: (row) => row.clientId,
        onError: (error) => reportFailure(error, "analyses.sync"),
      }),
      persistence,
      schemaVersion: 1,
      initialRender: { strategy: "network-first", networkTimeoutMs: 0 },
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
      collections: [collection, patientVersions],
      getArgs: ({ transaction }) => {
        const changes = transaction.mutations.filter((change) => change.collection.id === scope);
        if (
          changes.length !== 1 ||
          transaction.mutations.some(
            (change) =>
              change.collection.id !== scope && change.collection.id !== patientVersionScope,
          )
        )
          throw new NonRetriableError("INVALID_PATIENT_OPERATION");
        const change = changes[0]!;
        const row = (
          change.type === "delete" ? change.original : change.modified
        ) as PatientEnvelope;
        const decoded = openPatient(row, config.vault, scope);
        const previous =
          change.type === "insert"
            ? undefined
            : openPatient(change.original as PatientEnvelope, config.vault, scope);
        if (change.type !== "delete" && decoded.historyId && !decoded.deleted) {
          const snapshots = transaction.mutations
            .filter((change) => change.collection.id === patientVersionScope)
            .map((change) =>
              openPatientVersion(
                change.modified as PatientEnvelope,
                config.vault,
                patientVersionScope,
              ),
            );
          const snapshot = snapshots.find((snapshot) => snapshot.clientId === decoded.historyId);
          if (
            !snapshot ||
            snapshot.patientClientId !== decoded.clientId ||
            snapshot.revision !== decoded.revision ||
            JSON.stringify(snapshot.values) !==
              JSON.stringify(patientVersionValuesSchema.parse(decoded))
          )
            throw new NonRetriableError("INVALID_PATIENT_OPERATION");
        }
        return {
          actorId: config.userId,
          organizationId: config.organizationId,
          clientId: decoded.clientId,
          ...(change.type !== "delete" && decoded.historyId
            ? { historyId: decoded.historyId, expectedHistoryId: previous?.historyId ?? null }
            : {}),
          action:
            change.type === "insert"
              ? ("create" as const)
              : change.type === "delete" || decoded.deleted
                ? ("delete" as const)
                : ("update" as const),
          expectedRevision:
            change.type === "insert" ? 0 : (change.original as PatientEnvelope).revision,
          ...(change.type === "delete" || decoded.deleted
            ? {}
            : { values: patientValueSchema.parse(decoded) }),
        };
      },
    });
    const clinicalMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.clinicalRecords.apply,
      collections: [clinicalRecords, clinicalVersions],
      getArgs: ({ transaction }) => {
        const changes = transaction.mutations.filter(
          (change) => change.collection.id === clinicalScope,
        );
        if (
          changes.length !== 1 ||
          changes[0]!.type === "delete" ||
          transaction.mutations.some(
            (change) =>
              change.collection.id !== clinicalScope && change.collection.id !== versionScope,
          )
        )
          throw new NonRetriableError("INVALID_CLINICAL_RECORD");
        const change = changes[0]!;
        const row = openClinicalRecord(
          change.modified as ClinicalEnvelope,
          config.vault,
          clinicalScope,
        );
        const original =
          change.type !== "insert"
            ? openClinicalRecord(change.original as ClinicalEnvelope, config.vault, clinicalScope)
            : undefined;
        if (row.historyId && !row.deleted) {
          const archive = transaction.mutations
            .filter((change) => change.collection.id === versionScope)
            .map((change) =>
              openClinicalVersion(change.modified as ClinicalEnvelope, config.vault, versionScope),
            );
          const snapshot = archive.find((version) => version.clientId === row.historyId);
          if (
            !snapshot ||
            snapshot.recordClientId !== row.clientId ||
            snapshot.patientClientId !== row.patientClientId ||
            snapshot.revision !== row.revision ||
            JSON.stringify(snapshot.payload) !== JSON.stringify(row.payload)
          )
            throw new NonRetriableError("INVALID_CLINICAL_RECORD");
        }
        const versionedWrite =
          hasClinicalWriteId(row.payload) || hasClinicalWriteId(original?.payload);
        return {
          actorId: config.userId,
          organizationId: config.organizationId,
          clientId: row.clientId,
          patientClientId: row.patientClientId,
          ...(row.historyId
            ? { historyId: row.historyId, expectedHistoryId: original?.historyId ?? null }
            : {}),
          ...(versionedWrite
            ? {
                expectedWriteId: hasClinicalWriteId(original?.payload)
                  ? original.payload.writeId
                  : null,
              }
            : {}),
          action:
            change.type === "insert"
              ? ("create" as const)
              : row.deleted
                ? ("delete" as const)
                : ("update" as const),
          expectedRevision:
            change.type === "insert" ? 0 : (change.original as ClinicalEnvelope).revision,
          ...(row.payload ? { payload: row.payload } : {}),
        };
      },
    });
    const analysisMutation = convexOfflineMutation({
      client: config.client,
      mutation: api.analyses.apply,
      collections: [analyses],
      getArgs: ({ transaction }) => {
        const change = transaction.mutations[0];
        if (transaction.mutations.length !== 1 || !change || change.type === "delete")
          throw new NonRetriableError("INVALID_ANALYSIS");
        const row = readAnalysis(change.modified as PatientEnvelope, config.vault, analysisScope);
        return {
          actorId: config.userId,
          organizationId: config.organizationId,
          clientId: row.clientId,
          expectedRevision:
            change.type === "insert" ? 0 : (change.original as PatientEnvelope).revision,
          action:
            change.type === "insert"
              ? ("create" as const)
              : row.deleted
                ? ("delete" as const)
                : ("update" as const),
          ...(row.values ? { values: row.values } : {}),
        };
      },
    });
    const guarded =
      (invoke: typeof mutation, domain: "patient" | "clinical" | "analysis") =>
      async (params: Parameters<typeof mutation>[0]) => {
        if (closed || !detector.isOnline()) throw new Error("AUTH_REQUIRED");
        try {
          await invoke(params);
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
              "ACCOUNT_CHANGED",
              "PATIENT_NOT_FOUND",
              "INVALID_CLINICAL_RECORD",
              "INVALID_ISSUE_TRANSITION",
              "ISSUE_BINDING_IMMUTABLE",
              "ISSUE_REVIEWER_REQUIRED",
              "ISSUE_REVIEWER_UNAVAILABLE",
              "ISSUE_REVIEW_REQUIRED",
              "ISSUE_SERIOUSNESS_REQUIRED",
              "ISSUE_CORRECTIVE_ACTION_REQUIRED",
              "INVALID_ISSUE_REVIEW",

              "INVALID_ANALYSIS",
              "CLINICAL_KIND_IMMUTABLE",
              "FORM_VERSION_IMMUTABLE",
              "FINAL_ANSWER_IMMUTABLE",
              "AMENDMENT_REASON_REQUIRED",
              "FORM_VERSION_OUTDATED",
              "INVALID_STUDY_FORM",
              "INVALID_ENROLLMENT",
              "INVALID_ENROLLMENT_TRANSITION",
              "ENROLLMENT_BINDING_IMMUTABLE",
              "ENROLLMENT_HISTORY_IMMUTABLE",
              "ENROLLMENT_EXISTS",
              "PARTICIPATION_CONSENT_REQUIRED",
              "PARTICIPATION_CONSENT_EXPIRED",
              "PROTOCOL_OUTDATED",
              "RECRUITMENT_CLOSED",
              "ETHICS_APPROVAL_REQUIRED",
              "STUDY_VISIT_BINDING_IMMUTABLE",
              "ENROLLMENT_CHANGED",
              "PARTICIPATION_INACTIVE",
              "INVALID_VISIT_WINDOW",
              "VISIT_DEVIATION_REQUIRED",
              "VISIT_ACTUAL_DATE_REQUIRED",
              "INVALID_CLINICAL_DATE",
              "PROJECT_ARCHIVED",
              "PROJECT_COMPLETED",
              "INVALID_VISIT_TRANSITION",
              "VISIT_SCHEDULE_IMMUTABLE",
              "REVISION_CONFLICT",
              "ACCESS_DENIED",
              "INVALID_PATIENT",
              "IDEMPOTENCY_KEY_REUSED",
              "INVALID_CONSENT",
              "CONSENT_EXPIRED",
              "CONSENT_HISTORY_IMMUTABLE",
              "INVALID_CONSENT_RECIPIENT",
            ].find((c) => new RegExp(`\\b${c}\\b`).test(message)) ?? "PATIENT_SYNC_REJECTED";
          const change =
            domain === "clinical"
              ? params.transaction.mutations.find(
                  (change) => change.collection.id === clinicalScope,
                )
              : domain === "patient"
                ? params.transaction.mutations.find((change) => change.collection.id === scope)
                : params.transaction.mutations[0];
          let consentChange: ConsentEvent | undefined;
          if (domain === "patient" && change?.type === "update") {
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
                domain,
                envelope:
                  change.type === "delete" || (change.modified as PatientEnvelope).deleted
                    ? change.original
                    : change.modified,
                action:
                  change.type === "insert"
                    ? ("create" as const)
                    : change.type === "delete" || (change.modified as PatientEnvelope).deleted
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
      };
    const executor = startOfflineExecutor({
      collections: {
        [scope]: collection,
        [patientVersionScope]: patientVersions,
        [clinicalScope]: clinicalRecords,
        [versionScope]: clinicalVersions,
        [analysisScope]: analyses,
      },
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
        "patient.apply.v1": guarded(mutation, "patient"),
        "clinical.apply.v1": guarded(clinicalMutation, "clinical"),
        "analysis.apply.v1": guarded(analysisMutation, "analysis"),
      },
      shouldRetry: (error) => (error.message === "AUTH_REQUIRED" ? true : undefined),
      onStorageFailure: () => reportFailure(new Error("STORAGE_UNAVAILABLE"), "patients.queue"),
    });
    cleanupExecutor = () => executor.dispose();
    await executor.waitForInit();
    if (executor.mode !== "offline") throw new Error("STORAGE_UNAVAILABLE");
    const apply = executor.createOfflineAction<{
      expectedRevision: number;
      expectedHistoryId?: string | null;
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
        const prior = previous ? openPatient(previous, config.vault, scope) : undefined;
        if (command.action === "create" ? Boolean(prior) : !prior || prior.deleted)
          throw new Error("REVISION_CONFLICT");
        if (
          command.expectedHistoryId !== undefined &&
          (prior?.historyId ?? null) !== command.expectedHistoryId
        )
          throw new Error("REVISION_CONFLICT");
        const values =
          command.action === "delete"
            ? {
                fullName: "",
                birthDate: "",
                sex: "unknown" as const,
                diagnosisCodes: [],
                notes: "",
                consentHistory: [],
              }
            : command.action === "consent"
              ? {
                  ...patientVersionValuesSchema.parse(prior),
                  consentHistory: [
                    ...prior!.consentHistory,
                    consentEventSchema.parse(command.consent),
                  ],
                }
              : {
                  ...patientValueSchema.parse(command.values),
                  consentHistory:
                    prior?.consentHistory ??
                    patientValueSchema.parse(command.values).consentHistory,
                };
        if (command.action !== "delete")
          validateConsentTransition(
            prior?.consentHistory ?? [],
            values.consentHistory,
            config.userId,
            Date.now(),
          );
        const now = Date.now();
        const historyId = crypto.randomUUID();
        const revision = command.expectedRevision + 1;
        const envelope = patientEnvelope(
          {
            ...values,
            historyId,
            updatedBy: config.userId,
            clientId: command.clientId,
            revision,
            deleted: command.action === "delete",
            updatedAt: now,
          },
          config.vault,
          scope,
        );
        if (previous)
          collection.update(command.clientId, (draft) => Object.assign(draft, envelope));
        else collection.insert(envelope);
        if (command.action !== "delete") {
          if (prior) {
            const baselineId =
              prior.historyId ?? legacyPatientVersionId(prior.clientId, prior.revision);
            if (!patientVersions.has(baselineId))
              patientVersions.insert(
                sealPatientVersion(
                  {
                    clientId: baselineId,
                    patientClientId: prior.clientId,
                    revision: prior.revision,
                    values: patientVersionValuesSchema.parse(prior),
                    recordedAt: prior.updatedAt,
                    recordedBy: prior.updatedBy ?? "",
                    confirmed: false,
                  },
                  config.vault,
                  patientVersionScope,
                ),
              );
          }
          patientVersions.insert(
            sealPatientVersion(
              {
                clientId: historyId,
                patientClientId: command.clientId,
                revision,
                values: patientVersionValuesSchema.parse(values),
                recordedAt: now,
                recordedBy: config.userId,
                confirmed: false,
              },
              config.vault,
              patientVersionScope,
            ),
          );
        }
      },
    });
    const applyClinical = executor.createOfflineAction<ClinicalCommand>({
      mutationFnName: "clinical.apply.v1",
      onMutate: (command) => {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (config.role !== "doctor") throw new Error("ACCESS_DENIED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const parent = collection.get(command.patientClientId);
        if (!parent || parent.deleted) throw new Error("PATIENT_NOT_FOUND");
        const previous = clinicalRecords.get(command.clientId);
        if ((previous?.revision ?? 0) !== command.expectedRevision)
          throw new Error("REVISION_CONFLICT");
        const prior = previous
          ? openClinicalRecord(previous, config.vault, clinicalScope)
          : undefined;
        if (command.action === "create" ? Boolean(prior) : !prior || prior.deleted)
          throw new Error("REVISION_CONFLICT");
        if (
          command.expectedHistoryId !== undefined &&
          (prior?.historyId ?? null) !== command.expectedHistoryId
        )
          throw new Error("REVISION_CONFLICT");
        if (prior && prior.patientClientId !== command.patientClientId)
          throw new Error("ACCESS_DENIED");
        const parsedPayload =
          command.action === "delete" ? null : clinicalPayloadSchema.parse(command.payload);
        const payload = hasClinicalWriteId(parsedPayload)
          ? { ...parsedPayload, writeId: crypto.randomUUID() }
          : parsedPayload;
        if (prior?.payload && payload) validateClinicalTransition(prior.payload, payload);
        if (payload?.kind === "enrollment") {
          validateEnrollmentChange(
            prior?.payload?.kind === "enrollment" ? prior.payload : null,
            payload,
            config.userId,
            Date.now(),
          );
          if (
            command.action === "create" &&
            Array.from(clinicalRecords.values())
              .filter((row) => row.clientId !== snapshotId && !row.deleted)
              .map((row) => openClinicalRecord(row, config.vault, clinicalScope))
              .some(
                (row) =>
                  row.patientClientId === command.patientClientId &&
                  row.payload?.kind === "enrollment" &&
                  row.payload.projectClientId === payload.projectClientId,
              )
          )
            throw new Error("ENROLLMENT_EXISTS");
        }
        if (payload?.kind === "studyVisit") {
          if (command.action === "create" && payload.status !== "planned")
            throw new Error("INVALID_VISIT_TRANSITION");
          if (payload.performedOn > new Date().toISOString().slice(0, 10))
            throw new Error("INVALID_CLINICAL_DATE");
          const enrollmentEnvelope = clinicalRecords.get(payload.enrollmentClientId);
          const enrollment =
            enrollmentEnvelope && !enrollmentEnvelope.deleted
              ? openClinicalRecord(enrollmentEnvelope, config.vault, clinicalScope)
              : undefined;
          if (
            studyVisitNeedsAuthorization(
              prior?.payload?.kind === "studyVisit" ? prior.payload : null,
              payload,
            )
          ) {
            if (
              !enrollment ||
              enrollment.patientClientId !== command.patientClientId ||
              enrollment.payload?.kind !== "enrollment"
            )
              throw new Error("PARTICIPATION_INACTIVE");
            validateStudyVisitParticipation(payload, enrollment.payload, Date.now());
          }
        }
        if (payload?.kind === "studyIssue") {
          validateStudyIssueWrite(
            prior?.payload?.kind === "studyIssue" ? prior.payload : null,
            payload,
            config.userId,
            Date.now(),
          );
          if (command.action === "create") {
            const reference = clinicalRecords.get(payload.enrollmentClientId);
            const enrollment =
              reference && !reference.deleted
                ? openClinicalRecord(reference, config.vault, clinicalScope)
                : undefined;
            if (
              !enrollment ||
              enrollment.patientClientId !== command.patientClientId ||
              enrollment.payload?.kind !== "enrollment"
            )
              throw new Error("PARTICIPATION_INACTIVE");
            if (
              enrollment.payload.projectClientId !== payload.projectClientId ||
              enrollment.payload.protocolClientId !== payload.protocolClientId ||
              enrollment.payload.protocolVersion !== payload.protocolVersion
            )
              throw new Error("ISSUE_BINDING_IMMUTABLE");
          }
        }
        const now = Date.now();
        const historyId = crypto.randomUUID();
        const envelope = clinicalEnvelope(
          {
            clientId: command.clientId,
            patientClientId: command.patientClientId,
            historyId,
            updatedBy: config.userId,
            revision: command.expectedRevision + 1,
            deleted: command.action === "delete",
            payload,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          },
          config.vault,
          clinicalScope,
        );
        if (previous)
          clinicalRecords.update(command.clientId, (draft) => Object.assign(draft, envelope));
        else clinicalRecords.insert(envelope);
        if (payload) {
          if (prior?.payload) {
            const baselineId =
              prior.historyId ?? legacyClinicalVersionId(prior.clientId, prior.revision);
            if (!clinicalVersions.has(baselineId))
              clinicalVersions.insert(
                sealClinicalVersion(
                  {
                    clientId: baselineId,
                    recordClientId: prior.clientId,
                    patientClientId: prior.patientClientId,
                    revision: prior.revision,
                    payload: prior.payload,
                    recordedAt: prior.updatedAt,
                    recordedBy: prior.updatedBy ?? "",
                    confirmed: false,
                  },
                  config.vault,
                  versionScope,
                ),
              );
          }
          clinicalVersions.insert(
            sealClinicalVersion(
              {
                clientId: historyId,
                recordClientId: command.clientId,
                patientClientId: command.patientClientId,
                revision: command.expectedRevision + 1,
                payload,
                recordedAt: now,
                recordedBy: config.userId,
                confirmed: false,
              },
              config.vault,
              versionScope,
            ),
          );
        }
      },
    });
    const applyAnalysis = executor.createOfflineAction<AnalysisCommand>({
      mutationFnName: "analysis.apply.v1",
      onMutate: (command) => {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        const envelope = analyses.get(command.clientId);
        const previous = envelope ? readAnalysis(envelope, config.vault, analysisScope) : undefined;
        if (
          (previous?.revision ?? 0) !== command.expectedRevision ||
          (command.action === "create" ? Boolean(previous) : !previous || previous.deleted)
        )
          throw new Error("REVISION_CONFLICT");
        const now = Date.now();
        const row = sealAnalysis(
          {
            clientId: command.clientId,
            revision: command.expectedRevision + 1,
            deleted: command.action === "delete",
            values: command.action === "delete" ? null : analysisValuesSchema.parse(command.values),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          },
          config.vault,
          analysisScope,
        );
        if (previous) analyses.update(command.clientId, (draft) => Object.assign(draft, row));
        else analyses.insert(row);
      },
    });
    const persist = async (tx: ReturnType<typeof apply>) => {
      const persisted = receipts.wait(tx.id);
      try {
        await Promise.race([persisted, tx.when("settled").then(() => undefined)]);
      } finally {
        receipts.cancel(tx.id);
      }
      void tx.when("settled").catch((error) => reportFailure(error, "patients.sync"));
      return { transactionId: tx.id };
    };
    return {
      collection,
      patientSnapshotId,
      patientVersions,
      patientVersionSnapshotId,
      clinicalRecords,
      clinicalVersions,
      versionSnapshotId,
      clinicalSnapshotId: snapshotId,
      analyses,
      analysisSnapshotId,
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
      readPatientVersion(envelope: PatientEnvelope) {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        if (config.role !== "doctor") throw new Error("ACCESS_DENIED");
        const row = openPatientVersion(envelope, config.vault, patientVersionScope);
        const current = collection.get(row.patientClientId);
        if (!current || current.deleted) throw new Error("PATIENT_NOT_FOUND");
        return row;
      },
      readClinicalVersion(envelope: ClinicalEnvelope) {
        if (closed) throw new Error("WORKSPACE_LOCKED");
        if (Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        if (config.role !== "doctor") throw new Error("ACCESS_DENIED");
        const row = openClinicalVersion(envelope, config.vault, versionScope);
        const patient = collection.get(row.patientClientId);
        const current = clinicalRecords.get(row.recordClientId);
        if (!patient || patient.deleted || !current || current.deleted)
          throw new Error("PATIENT_NOT_FOUND");
        if (
          openClinicalRecord(current, config.vault, clinicalScope).patientClientId !==
          row.patientClientId
        )
          throw new Error("ACCESS_DENIED");
        return row;
      },
      readClinical: (envelope: ClinicalEnvelope) => {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        if (config.role !== "doctor") throw new Error("ACCESS_DENIED");
        const row = openClinicalRecord(envelope, config.vault, clinicalScope);
        const parent = collection.get(row.patientClientId);
        if (!parent || parent.deleted) throw new Error("PATIENT_NOT_FOUND");
        return row;
      },
      async saveClinical(command: ClinicalCommand) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        return persist(applyClinical(command));
      },
      readAnalysis: (envelope: PatientEnvelope) => {
        if (closed || Date.now() >= config.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
        return readAnalysis(envelope, config.vault, analysisScope);
      },
      async saveAnalysis(command: AnalysisCommand) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        return persist(applyAnalysis(command));
      },
      async save(command: Parameters<typeof apply>[0]) {
        if (!executor.isOfflineEnabled) throw new Error("WORKSPACE_READ_ONLY_TAB");
        return persist(apply(command));
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
      async cacheReviewers(rows: { userId: string; displayName: string }[]) {
        if (closed || config.role !== "doctor") throw new Error("ACCESS_DENIED");
        await metadata.set(
          "reviewers",
          JSON.stringify(
            z.array(z.object({ userId: z.string(), displayName: z.string() })).parse(rows),
          ),
        );
      },
      async cachedReviewers() {
        if (closed || Date.now() >= config.expiresAt || config.role !== "doctor")
          throw new Error("ACCESS_DENIED");
        const value = await metadata.get("reviewers");
        return z
          .array(z.object({ userId: z.string(), displayName: z.string() }))
          .parse(value ? JSON.parse(value) : []);
      },
      async failedActions(domain: "patient" | "clinical" | "analysis" = "patient") {
        const rows = await Promise.all(
          (await failures.keys()).map(async (key) =>
            failedActionSchema.parse(JSON.parse((await failures.get(key))!)),
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
          await Promise.all([
            collection.cleanup(),
            patientVersions.cleanup(),
            clinicalRecords.cleanup(),
            clinicalVersions.cleanup(),
            analyses.cleanup(),
          ]);
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
      await Promise.all([
        collection.cleanup(),
        patientVersions.cleanup(),
        clinicalRecords.cleanup(),
        clinicalVersions.cleanup(),
        analyses.cleanup(),
      ]);
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
