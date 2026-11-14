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
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { qualityReviewPayloadSchema } from "@/src/lib/data-quality-model";
import { analyzePatientQuality } from "@/src/lib/patient-data-quality";
import { patientTimeline } from "@/src/lib/patient-timeline";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
import { calculateStudyScores } from "@/src/lib/study-form-model";
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
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/studyForms.ts": () => import("@/convex/studyForms"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
it.each(["history", "visit", "questionnaire"] as const)(
  "restores the empty snapshot and encrypted %s create/update/delete queue",
  async (kind) => {
    const t = convexTest(schema, modules);
    const organizationId = await t.mutation(internal.provisioning.createOrganization, {
      name: "Clinic",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "doctor",
      organizationId,
      role: "doctor",
    });
    const doctor = t.withIdentity({ subject: "doctor" });
    const projectClientId = crypto.randomUUID();
    const formClientId = crypto.randomUUID();
    const formVersionClientId = crypto.randomUUID();
    const fieldId = crypto.randomUUID();
    const numericId = crypto.randomUUID();
    const definition = {
      title: "Confidential questionnaire title",
      description: "",
      fields: [
        {
          id: fieldId,
          type: "text" as const,
          label: "Confidential question",
          help: "",
          required: true,
          maxLength: 1000,
        },
        {
          id: numericId,
          type: "number" as const,
          label: "Confidential score input",
          help: "",
          required: true,
          minimum: 0,
          maximum: 10,
          unit: "",
          visibleWhen: {
            mode: "all" as const,
            rules: [{ fieldId, operator: "notEquals" as const, value: "Never" }],
          },
        },
      ],
      scores: [
        {
          id: crypto.randomUUID(),
          label: "Confidential score",
          description: "Custom research score",
          unit: "points",
          method: "sum" as const,
          terms: [{ fieldId: numericId, weight: 2 }],
        },
      ],
    };
    if (kind === "questionnaire") {
      await doctor.mutation(api.projects.apply, {
        actorId: "doctor",
        organizationId,
        clientId: projectClientId,
        expectedRevision: 0,
        idempotencyKey: "project",
        values: {
          title: "Study",
          summary: "",
          topic: "",
          kind: "retrospective",
          status: "draft",
          published: false,
          publicEligibility: "",
          publicContact: "",
        },
      });
      await doctor.mutation(api.studyForms.append, {
        actorId: "doctor",
        organizationId,
        projectClientId,
        formClientId,
        clientId: formVersionClientId,
        expectedVersion: 0,
        baseVersionClientId: null,
        definition,
        status: "published",
        idempotencyKey: "form",
      });
    }

    const patientClientId = crypto.randomUUID();
    await doctor.mutation(api.patients.apply, {
      actorId: "doctor",
      organizationId,
      clientId: patientClientId,
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "patient",
      values: {
        fullName: "Private patient",
        birthDate: "1990-01-01",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
      },
    });
    let snapshots = new Map<string, unknown>();
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
          await doctor.query(fn, { actorId: "doctor", organizationId }),
        );
      for (const listener of listeners) listener();
    };
    await refresh();
    // Upgrade an already prepared clinical workspace while the new history source is unavailable.
    snapshots.delete(getFunctionName(api.clinicalRecords.versions));
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
        const result = await doctor.mutation(fn, args);
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
    const metadataStorage = memoryStorage();
    const salt = newVaultSalt();
    let connection = network();
    const open = async (qualitySupported = true) => {
      connection = network();
      const space = await openPatientWorkspace({
        client,
        userId: "doctor",
        organizationId,
        role: "doctor",
        ...(qualitySupported ? { qualityReviewVersion: "patient-quality-v1" } : {}),
        expiresAt: Date.now() + 60000,
        storage,
        failureStorage,
        metadataStorage,
        persistence: createBrowserWASQLitePersistence({ database }),
        vault: await unlockVault("clinical-records private passphrase", salt),
        onlineDetector: connection,
        leaderElection: leader(),
        onAuthRequired() {},
      });
      await Promise.all([space.collection.preload(), space.clinicalRecords.preload()]);
      return space;
    };
    let workspace = await open();
    await Promise.all([workspace.collection.preload(), workspace.clinicalRecords.preload()]);
    expect(workspace.clinicalRecords.size).toBe(1); // An encrypted preparation marker, no medical record.
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await workspace.clinicalRecords.preload();
    expect(workspace.clinicalRecords.status).toBe("ready");
    const clientId = crypto.randomUUID();
    const privateContent = "Confidential clinical content";
    let payload: ClinicalPayload =
      kind === "history"
        ? {
            kind: "history",
            occurredOn: "2020-01-01",
            notes: "Private clinical note",
            text: privateContent,
          }
        : kind === "questionnaire"
          ? {
              kind: "questionnaire",
              writeId: crypto.randomUUID(),
              occurredOn: "2020-01-01",
              notes: "Private clinical note",
              projectClientId,
              formClientId,
              formVersionClientId,
              formVersion: 1,
              definition,
              answers: { [fieldId]: privateContent, [numericId]: 0 },
              status: "draft",
              amendmentReason: "",
            }
          : {
              kind: "visit",
              occurredOn: "2026-11-01",
              notes: "Private clinical note",
              scheduledFor: "2026-11-01T01:30:00-04:00[America/New_York]",
              durationMinutes: 30,
              visitType: "consultation",
              status: "planned",
              reason: privateContent,
              location: "Private place",
              outcome: "",
              followUpOn: "",
              cancellationReason: "",
            };
    const queued = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 0,
      action: "create",
      payload,
    });
    if (kind === "questionnaire")
      payload = workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload!;
    if (payload.kind === "questionnaire")
      expect(calculateStudyScores(payload.definition, payload.answers)[0]).toMatchObject({
        status: "calculated",
        value: 0,
      });
    const initialHistoryId = workspace.readClinical(
      workspace.clinicalRecords.get(clientId)!,
    ).historyId!;
    expect(
      workspace.readClinicalVersion(workspace.clinicalVersions.get(initialHistoryId)!),
    ).toMatchObject({ revision: 1, payload, confirmed: false });
    expect(calls).toBe(0);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(privateContent);
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toEqual(
      payload,
    );
    const timeline = patientTimeline(
      [workspace.readClinical(workspace.clinicalRecords.get(clientId)!)],
      {
        patientId: patientClientId,
        role: "doctor",
        expiresAt: Date.now() + 60000,
        now: Date.now(),
      },
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.source.payload).toEqual(payload);
    expect(timeline[0]?.type).toBe(kind === "visit" ? "visitSchedule" : "entry");
    expect(
      workspace.readClinicalVersion(workspace.clinicalVersions.get(initialHistoryId)!),
    ).toMatchObject({ revision: 1, payload, confirmed: false });
    await refresh();
    const completion = workspace.executor.waitForTransactionCompletion(queued.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await completion;
    expect(calls).toBe(1);
    expect(
      workspace.readClinicalVersion(workspace.clinicalVersions.get(initialHistoryId)!),
    ).toMatchObject({ revision: 1, payload, confirmed: true, recordedBy: "doctor" });
    expect(
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }),
    ).toHaveLength(1);
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toEqual(
      payload,
    );
    expect(await workspace.executor.peekOutbox()).toEqual([]);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const storedRows = tables.flatMap((table) =>
      sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
    );
    expect(JSON.stringify(storedRows)).not.toContain(privateContent);
    expect(JSON.stringify(storedRows)).not.toContain("Confidential score");
    expect(JSON.stringify(storedRows)).not.toContain(payload.notes);
    await refresh();
    connection.disconnect();
    const conflict = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 1,
      action: "update",
      payload: { ...payload, notes: "Rejected local clinical draft" },
    });
    const capturedBranchId = workspace.readClinical(
      workspace.clinicalRecords.get(clientId)!,
    ).historyId!;
    const dependent = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 2,
      action: "update",
      payload: { ...payload, notes: "Dependent clinical draft" },
    });
    await doctor.mutation(api.clinicalRecords.apply, {
      actorId: "doctor",
      organizationId,
      clientId,
      patientClientId,
      expectedRevision: 1,
      action: "update",
      ...(payload.kind === "questionnaire" ? { expectedWriteId: payload.writeId } : {}),
      payload: {
        ...payload,
        notes: "Authoritative clinical history",
        ...(payload.kind === "questionnaire" ? { writeId: crypto.randomUUID() } : {}),
      },
      idempotencyKey: "another-doctor",
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await refresh();
    const conflictSettled = workspace.executor.waitForTransactionCompletion(conflict.transactionId);
    const dependentSettled = dependent
      ? workspace.executor.waitForTransactionCompletion(dependent.transactionId)
      : null;
    const settledConflicts = Promise.allSettled([
      conflictSettled,
      ...(dependentSettled ? [dependentSettled] : []),
    ]);
    connection.connect();
    workspace.setAuthenticated(true);
    expect((await settledConflicts).map((result) => result.status)).toEqual(
      dependent ? ["rejected", "rejected"] : ["rejected"],
    );
    const rejected = await workspace.failedActions("clinical");
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.code).toBe("REVISION_CONFLICT");
    await expect(
      workspace.saveClinical({
        clientId,
        patientClientId,
        expectedRevision: 2,
        expectedHistoryId: capturedBranchId,
        action: "update",
        payload: { ...payload, notes: "Stale editor after rollback" },
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(workspace.readClinical(rejected[0]!.envelope).payload).toMatchObject({
      notes: "Rejected local clinical draft",
    });
    expect(JSON.stringify([...failureStorage.values.values()])).not.toContain(
      "Rejected local clinical draft",
    );
    await expect(
      workspace.saveClinical({
        clientId,
        patientClientId,
        expectedRevision: 1,
        action: "update",
        payload,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const serverHistory = await doctor.query(api.clinicalRecords.versions, {
      actorId: "doctor",
      organizationId,
    });
    expect(serverHistory).toHaveLength(2);
    expect(serverHistory.map((row) => row.payload.notes)).not.toContain(
      "Rejected local clinical draft",
    );
    expect(serverHistory.map((row) => row.payload.notes)).not.toContain("Dependent clinical draft");
    connection.disconnect();
    const updated = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 2,
      action: "update",
      payload: { ...payload, notes: "Confirmed clinical revision" },
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await refresh();
    const updatedSettled = workspace.executor.waitForTransactionCompletion(updated.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await updatedSettled;
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).revision).toBe(3);
    connection.disconnect();
    const deleted = await workspace.saveClinical({
      clientId,
      patientClientId,
      expectedRevision: 3,
      action: "delete",
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(clientId)!).payload).toBeNull();
    expect(() =>
      workspace.readClinicalVersion(workspace.clinicalVersions.get(initialHistoryId)!),
    ).toThrow("PATIENT_NOT_FOUND");
    await refresh();
    const deletedSettled = workspace.executor.waitForTransactionCompletion(deleted.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await deletedSettled;
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }))[0],
    ).toMatchObject({ deleted: true, payload: null, revision: 4 });
    expect(await workspace.executor.peekOutbox()).toEqual([]);

    if (kind === "history") {
      connection.disconnect();
      const localPatient = workspace.read(workspace.collection.get(patientClientId)!);
      const day = new Date().toISOString().slice(0, 10);
      const qualitySourceId = crypto.randomUUID();
      const queuedSource = await workspace.saveClinical({
        clientId: qualitySourceId,
        patientClientId,
        expectedRevision: 0,
        expectedHistoryId: null,
        action: "create",
        payload: {
          kind: "observation",
          occurredOn: "2020-01-01",
          notes: "Confidential pending source",
          name: "Pending source result",
          code: "",
          numericValue: 0,
          textValue: "",
          unit: "",
        },
      });
      const report = analyzePatientQuality(
        localPatient,
        [workspace.readClinical(workspace.clinicalRecords.get(qualitySourceId)!)],
        day,
      );
      const finding = report.findings.find((finding) => finding.code === "allergiesUndocumented")!;
      const review = qualityReviewPayloadSchema.parse({
        kind: "qualityReview",
        writeId: crypto.randomUUID(),
        occurredOn: day,
        notes: "Confidential quality decision",
        algorithmVersion: "patient-quality-v1",
        evaluationDate: day,
        sourceSignature: report.sourceSignature,
        findingKey: finding.key,
        code: finding.code,
        decision: "needsClarification",
        reviewedBy: "doctor",
      });
      // A cached workspace without the server capability must preserve older
      // pending work while refusing to queue a new, unsupported payload kind.
      await workspace.close();
      workspace = await open(false);
      const beforeUnsupported = await workspace.executor.peekOutbox();
      expect(beforeUnsupported).toHaveLength(1);
      await expect(
        workspace.saveClinical({
          clientId: crypto.randomUUID(),
          patientClientId,
          expectedRevision: 0,
          expectedHistoryId: null,
          action: "create",
          payload: review,
        }),
      ).rejects.toThrow("QUALITY_NOT_PREPARED");
      expect(await workspace.executor.peekOutbox()).toHaveLength(beforeUnsupported.length);
      expect(
        workspace.readClinical(workspace.clinicalRecords.get(qualitySourceId)!).payload?.kind,
      ).toBe("observation");
      await workspace.close();
      workspace = await open();
      const reviewId = crypto.randomUUID();
      const queuedReview = await workspace.saveClinical({
        clientId: reviewId,
        patientClientId,
        expectedRevision: 0,
        expectedHistoryId: null,
        action: "create",
        payload: review,
      });
      expect(JSON.stringify([...storage.values.values()])).not.toContain(review.notes);
      await workspace.close();
      snapshots = new Map();
      workspace = await open();
      expect(workspace.readClinical(workspace.clinicalRecords.get(reviewId)!).payload?.notes).toBe(
        review.notes,
      );
      await refresh();
      const delivered = workspace.executor.waitForTransactionCompletion(queuedReview.transactionId);
      const sourceDelivered = workspace.executor.waitForTransactionCompletion(
        queuedSource.transactionId,
      );
      connection.connect();
      workspace.setAuthenticated(true);
      await Promise.all([sourceDelivered, delivered]);
      expect(
        analyzePatientQuality(
          workspace.read(workspace.collection.get(patientClientId)!),
          [workspace.readClinical(workspace.clinicalRecords.get(qualitySourceId)!)],
          day,
        ).sourceSignature,
      ).toBe(report.sourceSignature);
      expect(
        (
          await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })
        ).filter((row) => row.payload?.kind === "qualityReview"),
      ).toHaveLength(1);
      connection.disconnect();
      const rejectedReview = await workspace.saveClinical({
        clientId: crypto.randomUUID(),
        patientClientId,
        expectedRevision: 0,
        expectedHistoryId: null,
        action: "create",
        payload: { ...review, notes: "Confidential stale quality decision" },
      });
      await doctor.mutation(api.clinicalRecords.apply, {
        actorId: "doctor",
        organizationId,
        patientClientId,
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create",
        payload: {
          kind: "observation",
          occurredOn: "2020-01-01",
          notes: "",
          name: "New external record",
          code: "",
          numericValue: 1,
          textValue: "",
          unit: "",
        },
        idempotencyKey: "external-quality-source",
      });
      const settled = workspace.executor.waitForTransactionCompletion(rejectedReview.transactionId);
      connection.connect();
      await expect(settled).rejects.toThrow();
      const failure = (await workspace.failedActions("clinical")).find(
        (row) => row.code === "QUALITY_SOURCE_CHANGED",
      );
      expect(failure).toBeDefined();
      expect(
        (
          await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })
        ).filter((row) => row.payload?.kind === "qualityReview"),
      ).toHaveLength(1);
      expect(JSON.stringify([...failureStorage.values.values()])).not.toContain(
        "Confidential stale quality decision",
      );
      expect(workspace.readClinical(failure!.envelope).payload?.notes).toBe(
        "Confidential stale quality decision",
      );
      await workspace.close();
      snapshots = new Map();
      workspace = await open();
      const preserved = (await workspace.failedActions("clinical")).find(
        (row) => row.id === failure!.id,
      );
      expect(preserved).toBeDefined();
      expect(workspace.readClinical(preserved!.envelope).payload?.notes).toBe(
        "Confidential stale quality decision",
      );
    }
    if (kind === "questionnaire") {
      connection.disconnect();
      const stale = await workspace.saveClinical({
        clientId: crypto.randomUUID(),
        patientClientId,
        expectedRevision: 0,
        action: "create",
        payload,
      });
      await doctor.mutation(api.studyForms.append, {
        actorId: "doctor",
        organizationId,
        projectClientId,
        formClientId,
        clientId: crypto.randomUUID(),
        expectedVersion: 1,
        baseVersionClientId: formVersionClientId,
        definition,
        status: "published",
        idempotencyKey: "changed-form",
      });
      const completion = workspace.executor.waitForTransactionCompletion(stale.transactionId);
      connection.connect();
      await expect(completion).rejects.toThrow();
      const failure = (await workspace.failedActions("clinical")).find(
        (row) => row.code === "FORM_VERSION_OUTDATED",
      );
      expect(failure).toBeDefined();
      const saved = workspace.readClinical(failure!.envelope).payload;
      expect(saved?.kind === "questionnaire" ? saved.answers[fieldId] : null).toBe(privateContent);
    }
    await workspace.close();
    sqlite.close();
  },
);
