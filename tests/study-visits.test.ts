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
import { clinicalPayloadSchema, validateClinicalTransition } from "@/src/lib/clinical-record-model";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
import { enrollmentPayloadSchema } from "@/src/lib/study-enrollment-model";
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import { validateStudyVisitParticipation } from "@/src/lib/study-visit-model";
import type { StudyVisitPayload } from "@/src/lib/study-visit-model";
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

const today = () => new Date().toISOString().slice(0, 10);
const future = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
function nextEvent(status: EnrollmentStatus) {
  return {
    id: crypto.randomUUID(),
    status,
    occurredOn: today(),
    reason: "Confidential recruitment reason",
    recordedBy: "doctor",
    recordedAt: Date.now(),
    eligibilityEvidence: status === "enrolled" ? "Confidential screening assessment" : "",
    inclusionConfirmed: status === "enrolled",
    exclusionAbsent: status === "enrolled",
    consent:
      status === "enrolled"
        ? {
            documentReference: "Confidential consent document",
            version: "1",
            signedOn: today(),
            expiresOn: future(),
          }
        : null,
  };
}
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "Clinic",
    kind: "clinic",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  for (const [userId, role] of [
    ["doctor", "doctor"],
    ["viewer", "doctor"],
    ["other", "doctor"],
    ["researcher", "researcher"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, organizationId, role });
  const doctor = t.withIdentity({ subject: "doctor" });
  const projectClientId = crypto.randomUUID();
  const protocolClientId = crypto.randomUUID();
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
      kind: "prospective",
      status: "draft",
      published: false,
      publicEligibility: "",
      publicContact: "",
    },
  });
  await t.run(async (ctx) => {
    const project = (await ctx.db.query("projects").collect())[0]!;
    await ctx.db.patch(project._id, { status: "recruiting" });
    await ctx.db.insert("studyProtocols", {
      clientId: protocolClientId,
      projectClientId,
      version: 1,
      hypothesis: "Question",
      inclusion: "Eligible",
      exclusion: "Exclusions",
      endpoints: "Outcome",
      analysisPlan: "Plan",
      ethicsApproved: true,
      ethicsReference: "Approval",
      ethicsExpiresAt: Date.now() + 86400000,
      createdAt: Date.now(),
      createdBy: "doctor",
    });
    await ctx.db.insert("projectMembers", {
      clientId: crypto.randomUUID(),
      projectClientId,
      userId: "viewer",
      organizationId,
      role: "viewer",
      active: true,
      revision: 1,
    });
  });
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
  const payload: EnrollmentPayload = {
    kind: "enrollment",
    writeId: crypto.randomUUID(),
    projectClientId,
    protocolClientId,
    protocolVersion: 1,
    occurredOn: today(),
    notes: "",
    events: [nextEvent("screening")],
  };
  const args = {
    actorId: "doctor",
    organizationId,
    clientId: crypto.randomUUID(),
    patientClientId,
    action: "create" as const,
    expectedRevision: 0,
    expectedWriteId: null as string | null,
    payload,
    idempotencyKey: "screening",
  };
  const apply = (
    input:
      | typeof args
      | (Omit<typeof args, "payload"> & {
          action: "create" | "update" | "delete";
          payload?: ClinicalPayload;
        }),
  ) => doctor.mutation(api.clinicalRecords.apply, input);
  const update = (previous: EnrollmentPayload, status: EnrollmentStatus, expectedRevision = 1) => ({
    ...args,
    action: "update" as const,
    expectedRevision,
    expectedWriteId: previous.writeId,
    payload: {
      ...previous,
      writeId: crypto.randomUUID(),
      events: [...previous.events, nextEvent(status)],
    },
    idempotencyKey: crypto.randomUUID(),
  });
  return {
    t,
    doctor,
    organizationId,
    projectClientId,
    protocolClientId,
    patientClientId,
    payload,
    args,
    apply,
    update,
  };
}

async function visitSetup() {
  const context = await setup();
  await context.apply(context.args);
  const enrolled = context.update(context.payload, "enrolled");
  await context.doctor.mutation(api.clinicalRecords.apply, enrolled);
  const payload: StudyVisitPayload = {
    kind: "studyVisit",
    writeId: crypto.randomUUID(),
    enrollmentClientId: context.args.clientId,
    enrollmentWriteId: enrolled.payload.writeId,
    projectClientId: context.projectClientId,
    protocolClientId: context.protocolClientId,
    protocolVersion: 1,
    occurredOn: today(),
    scheduledFor: `${today()}T12:00:00+00:00[UTC]`,
    durationMinutes: 30,
    visitType: "followUp",
    status: "planned",
    reason: "Confidential research procedure",
    location: "Confidential clinic room",
    outcome: "",
    notes: "Confidential visit note",
    followUpOn: "",
    cancellationReason: "",
    windowFrom: today(),
    windowTo: today(),
    performedOn: "",
    deviationReason: "",
    amendmentReason: "",
  };
  const args = {
    ...context.args,
    clientId: crypto.randomUUID(),
    payload,
    idempotencyKey: "study-visit",
  };
  const change = (
    previous: StudyVisitPayload,
    status: StudyVisitPayload["status"],
    revision = 1,
  ) => ({
    ...args,
    action: "update" as const,
    expectedRevision: revision,
    expectedWriteId: previous.writeId,
    payload: {
      ...previous,
      writeId: crypto.randomUUID(),
      status,
      ...(["inProgress", "completed"].includes(status) ? { performedOn: today() } : {}),
      ...(status === "completed" ? { outcome: "Confidential research outcome" } : {}),
      ...(status === "cancelled" ? { cancellationReason: "Confidential cancellation" } : {}),
    },
    idempotencyKey: crypto.randomUUID(),
  });
  return { ...context, enrolled, args, payload, change };
}
it("evaluates consent and protocol windows on UTC dates across IANA date boundaries", async () => {
  const { payload, enrolled } = await visitSetup();
  const value = {
    ...payload,
    scheduledFor: "2026-11-14T01:00:00+04:00[Europe/Samara]",
    occurredOn: "2026-11-14",
    windowFrom: "2026-11-14",
    windowTo: "2026-11-14",
  };
  expect(clinicalPayloadSchema.safeParse(value).success).toBe(false);
  expect(
    clinicalPayloadSchema.safeParse({ ...value, deviationReason: "UTC window deviation" }).success,
  ).toBe(true);
  const enrollment = enrollmentPayloadSchema.parse({
    ...enrolled.payload,
    occurredOn: "2026-11-14",
    events: enrolled.payload.events.map((event) =>
      event.status === "enrolled"
        ? {
            ...event,
            occurredOn: "2026-11-14",
            consent: {
              documentReference: "Doc",
              version: "1",
              signedOn: "2026-11-14",
              expiresOn: "2026-11-15",
            },
          }
        : { ...event, occurredOn: "2026-11-14" },
    ),
  });
  expect(() =>
    validateStudyVisitParticipation(
      { ...value, deviationReason: "UTC window deviation" },
      enrollment,
      Date.parse("2026-11-14T12:00:00Z"),
    ),
  ).toThrow("PARTICIPATION_CONSENT_EXPIRED");
});
describe("research visit authorization and clinical record lifecycle", () => {
  it("validates actual dates, protocol windows, deviations and terminal amendments", async () => {
    const { payload } = await visitSetup();
    expect(clinicalPayloadSchema.safeParse({ ...payload, performedOn: today() }).success).toBe(
      false,
    );
    expect(
      clinicalPayloadSchema.safeParse({ ...payload, status: "completed", outcome: "" }).success,
    ).toBe(false);
    expect(
      clinicalPayloadSchema.safeParse({
        ...payload,
        status: "completed",
        outcome: "Recorded",
        performedOn: "",
      }).success,
    ).toBe(false);
    expect(
      clinicalPayloadSchema.safeParse({ ...payload, windowFrom: future(), windowTo: today() })
        .success,
    ).toBe(false);
    expect(
      clinicalPayloadSchema.safeParse({ ...payload, windowFrom: future(), windowTo: future() })
        .success,
    ).toBe(false);
    expect(
      clinicalPayloadSchema.safeParse({
        ...payload,
        windowFrom: future(),
        windowTo: future(),
        deviationReason: "Clinician documented deviation",
      }).success,
    ).toBe(true);
    const done = {
      ...payload,
      status: "completed" as const,
      performedOn: today(),
      outcome: "Result",
    };
    expect(() => validateClinicalTransition(done, { ...done, outcome: "Correction" })).toThrow(
      "AMENDMENT_REASON_REQUIRED",
    );
    expect(() =>
      validateClinicalTransition(done, { ...done, status: "planned", amendmentReason: "Reason" }),
    ).toThrow("INVALID_VISIT_TRANSITION");
    expect(() =>
      validateClinicalTransition(done, { ...done, windowTo: future(), amendmentReason: "Reason" }),
    ).toThrow("VISIT_SCHEDULE_IMMUTABLE");
    expect(() =>
      validateClinicalTransition(done, {
        ...done,
        protocolClientId: crypto.randomUUID(),
        amendmentReason: "Reason",
      }),
    ).toThrow("STUDY_VISIT_BINDING_IMMUTABLE");
  });
  it("persists results, replays exactly once and does not grant researcher access", async () => {
    const { t, doctor, organizationId, args, change } = await visitSetup();
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    const done = change(args.payload, "completed");
    await doctor.mutation(api.clinicalRecords.apply, done);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", args.payload.projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    const amended = {
      ...change(done.payload, "completed", 2),
      payload: {
        ...done.payload,
        writeId: crypto.randomUUID(),
        outcome: "Corrected outcome",
        amendmentReason: "Correction evidence",
      },
    };
    await doctor.mutation(api.clinicalRecords.apply, amended);
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })).find(
        (row) => row.clientId === args.clientId,
      ),
    ).toMatchObject({
      revision: 3,
      payload: { status: "completed", outcome: "Corrected outcome" },
    });
    const researcher = t.withIdentity({ subject: "researcher" });
    expect(
      await researcher.query(api.clinicalRecords.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    for (const actorId of ["researcher", "viewer", "other"])
      await expect(
        t
          .withIdentity({ subject: actorId })
          .mutation(api.clinicalRecords.apply, { ...args, clientId: crypto.randomUUID(), actorId }),
      ).rejects.toThrow("ACCESS_DENIED");
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Confidential|Corrected|evidence/);
  });
  it("rejects changed participation, expired consent and mismatched patient bindings", async () => {
    const { t, doctor, organizationId, args, enrolled, update } = await visitSetup();
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, enrollmentWriteId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("ENROLLMENT_CHANGED");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, protocolVersion: 2 },
      }),
    ).rejects.toThrow("STUDY_VISIT_BINDING_IMMUTABLE");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: {
          ...args.payload,
          scheduledFor: `${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)}T12:00:00+00:00[UTC]`,
          occurredOn: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
          deviationReason: "Outside window",
        },
      }),
    ).rejects.toThrow("PARTICIPATION_CONSENT_EXPIRED");
    const another = crypto.randomUUID();
    await doctor.mutation(api.patients.apply, {
      actorId: "doctor",
      organizationId,
      clientId: another,
      expectedRevision: 0,
      action: "create",
      idempotencyKey: "another-patient",
      values: {
        fullName: "Another private patient",
        birthDate: "1990-01-01",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
      },
    });
    await expect(
      doctor.mutation(api.clinicalRecords.apply, { ...args, patientClientId: another }),
    ).rejects.toThrow("PARTICIPATION_INACTIVE");
    await doctor.mutation(api.clinicalRecords.apply, update(enrolled.payload, "withdrawn", 2));
    await expect(doctor.mutation(api.clinicalRecords.apply, args)).rejects.toThrow(
      "ENROLLMENT_CHANGED",
    );
    const rows = await doctor.query(api.clinicalRecords.list, {
      actorId: "doctor",
      organizationId,
    });
    const current = rows.find((row) => row.clientId === args.payload.enrollmentClientId)!.payload;
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: {
          ...args.payload,
          enrollmentWriteId: current?.kind === "enrollment" ? current.writeId : crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow("PARTICIPATION_INACTIVE");
  });
  it("checks ethics and current protocol while preserving cancellation after project access is revoked", async () => {
    const { t, doctor, args, projectClientId, protocolClientId, change } = await visitSetup();
    await doctor.mutation(api.clinicalRecords.apply, args);
    await t.run(async (ctx) => {
      const protocol = await ctx.db
        .query("studyProtocols")
        .withIndex("by_client", (q) => q.eq("clientId", protocolClientId))
        .unique();
      await ctx.db.patch(protocol!._id, { ethicsExpiresAt: Date.now() - 1 });
    });
    await expect(
      doctor.mutation(api.clinicalRecords.apply, change(args.payload, "inProgress")),
    ).rejects.toThrow("ETHICS_APPROVAL_REQUIRED");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("studyProtocols")
        .withIndex("by_client", (q) => q.eq("clientId", protocolClientId))
        .unique();
      const { _id, _creationTime, ...values } = row!;
      await ctx.db.insert("studyProtocols", {
        ...values,
        clientId: crypto.randomUUID(),
        version: 2,
        ethicsExpiresAt: Date.now() + 86400000,
      });
    });
    await expect(
      doctor.mutation(api.clinicalRecords.apply, change(args.payload, "inProgress")),
    ).rejects.toThrow("PROTOCOL_OUTDATED");
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, args)).rejects.toThrow("ACCESS_DENIED");
    const canceled = change(args.payload, "cancelled");
    await doctor.mutation(api.clinicalRecords.apply, canceled);
    const { payload: _payload, ...remove } = canceled;
    await doctor.mutation(api.clinicalRecords.apply, {
      ...remove,
      action: "delete",
      expectedRevision: 2,
      expectedWriteId: canceled.payload.writeId,
      idempotencyKey: "delete",
    });
  });
});

it("restores encrypted research visits, archives withdrawal-before-delivery and preserves dependent-write conflicts", async () => {
  const {
    t,
    doctor,
    organizationId,
    patientClientId,
    projectClientId,
    args,
    payload,
    enrolled,
    update,
    change,
  } = await visitSetup();
  let snapshots = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const refresh = async () => {
    for (const fn of [
      api.patients.list,
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
  const open = async () => {
    connection = network();
    const space = await openPatientWorkspace({
      client,
      userId: "doctor",
      organizationId,
      role: "doctor",
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
  const id = args.clientId;
  const queued = await workspace.saveClinical({
    clientId: id,
    patientClientId,
    expectedRevision: 0,
    action: "create",
    payload,
  });
  const local = workspace.readClinical(workspace.clinicalRecords.get(id)!)
    .payload as StudyVisitPayload;
  expect(calls).toBe(0);
  expect(JSON.stringify([...storage.values.values()])).not.toContain("Confidential");
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  expect(workspace.readClinical(workspace.clinicalRecords.get(id)!).payload).toEqual(local);
  await refresh();
  const first = workspace.executor.waitForTransactionCompletion(queued.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await first;
  connection.disconnect();
  const a = await workspace.saveClinical({
    clientId: id,
    patientClientId,
    expectedRevision: 1,
    action: "update",
    payload: { ...local, location: "Confidential local room" },
  });
  const a2 = workspace.readClinical(workspace.clinicalRecords.get(id)!)
    .payload as StudyVisitPayload;
  const b = await workspace.saveClinical({
    clientId: id,
    patientClientId,
    expectedRevision: 2,
    action: "update",
    payload: { ...a2, notes: "Confidential dependent note" },
  });
  const concurrent = {
    ...change(local, "planned"),
    payload: { ...local, writeId: crypto.randomUUID(), location: "Authoritative room" },
  };
  await doctor.mutation(api.clinicalRecords.apply, concurrent);
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const both = Promise.allSettled(
    [a, b].map((row) => workspace.executor.waitForTransactionCompletion(row.transactionId)),
  );
  connection.connect();
  workspace.setAuthenticated(true);
  expect((await both).map((row) => row.status)).toEqual(["rejected", "rejected"]);
  expect((await workspace.failedActions("clinical")).map((row) => row.code)).toEqual([
    "REVISION_CONFLICT",
    "REVISION_CONFLICT",
  ]);
  expect(JSON.stringify([...failureStorage.values.values()])).not.toContain("Confidential");
  connection.disconnect();
  const current = workspace.readClinical(workspace.clinicalRecords.get(id)!)
    .payload as StudyVisitPayload;
  const done = await workspace.saveClinical({
    clientId: id,
    patientClientId,
    expectedRevision: 2,
    action: "update",
    payload: {
      ...current,
      status: "completed",
      performedOn: today(),
      outcome: "Confidential research outcome",
    },
  });
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const completed = workspace.executor.waitForTransactionCompletion(done.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await completed;
  connection.disconnect();
  const pending = await workspace.saveClinical({
    clientId: crypto.randomUUID(),
    patientClientId,
    expectedRevision: 0,
    action: "create",
    payload,
  });
  await doctor.mutation(api.clinicalRecords.apply, update(enrolled.payload, "withdrawn", 2));
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const invalidated = workspace.executor.waitForTransactionCompletion(pending.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await expect(invalidated).rejects.toThrow();
  expect(
    (await workspace.failedActions("clinical")).some((row) => row.code === "ENROLLMENT_CHANGED"),
  ).toBe(true);
  connection.disconnect();
  const deleted = await workspace.saveClinical({
    clientId: id,
    patientClientId,
    expectedRevision: 3,
    action: "delete",
  });
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  expect(workspace.readClinical(workspace.clinicalRecords.get(id)!).payload).toBeNull();
  await refresh();
  const deletion = workspace.executor.waitForTransactionCompletion(deleted.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await deletion;
  expect(
    (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })).find(
      (row) => row.clientId === id,
    ),
  ).toMatchObject({ revision: 4, deleted: true, payload: null });
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  expect(
    JSON.stringify(
      tables.flatMap((table) =>
        sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
      ),
    ),
  ).not.toContain("Confidential");
  await workspace.close();
  sqlite.close();
});
