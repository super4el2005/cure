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
import { enrollmentRegister } from "@/src/lib/enrollment-register";
import { newVaultSalt, unlockVault } from "@/src/lib/patient-vault";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
import {
  enrollmentPayloadSchema,
  validateEnrollmentChange,
} from "@/src/lib/study-enrollment-model";
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";
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
describe("study participation evidence and clinic rights", () => {
  it("requires explicit criteria and consent, preserves history, and restricts lifecycle", async () => {
    const { payload } = await setup();
    const enrolled = { ...payload, events: [...payload.events, nextEvent("enrolled")] };
    expect(
      enrollmentPayloadSchema.safeParse({
        ...enrolled,
        events: [...payload.events, { ...nextEvent("enrolled"), consent: null }],
      }).success,
    ).toBe(false);
    expect(
      enrollmentPayloadSchema.safeParse({
        ...enrolled,
        events: [...payload.events, { ...nextEvent("enrolled"), inclusionConfirmed: false }],
      }).success,
    ).toBe(false);
    expect(
      enrollmentPayloadSchema.safeParse({
        ...enrolled,
        events: [...payload.events, { ...nextEvent("enrolled"), exclusionAbsent: false }],
      }).success,
    ).toBe(false);
    expect(
      enrollmentPayloadSchema.safeParse({
        ...enrolled,
        events: [...payload.events, { ...nextEvent("enrolled"), eligibilityEvidence: "" }],
      }).success,
    ).toBe(false);
    expect(() => validateEnrollmentChange(payload, enrolled, "other", Date.now())).toThrow(
      "INVALID_ENROLLMENT",
    );
    expect(() =>
      validateEnrollmentChange(
        payload,
        {
          ...enrolled,
          events: [{ ...payload.events[0]!, reason: "Changed" }, enrolled.events[1]!],
        },
        "doctor",
        Date.now(),
      ),
    ).toThrow("ENROLLMENT_HISTORY_IMMUTABLE");
    expect(() =>
      validateEnrollmentChange(
        payload,
        { ...enrolled, protocolClientId: crypto.randomUUID() },
        "doctor",
        Date.now(),
      ),
    ).toThrow("ENROLLMENT_BINDING_IMMUTABLE");
    const withdrawn = { ...enrolled, events: [...enrolled.events, nextEvent("withdrawn")] };
    expect(
      enrollmentPayloadSchema.safeParse({
        ...withdrawn,
        events: [...withdrawn.events, nextEvent("enrolled")],
      }).success,
    ).toBe(false);
    const last = {
      ...nextEvent("enrolled"),
      occurredOn: "2020-01-02",
      consent: {
        documentReference: "Doc",
        version: "1",
        signedOn: "2020-01-01",
        expiresOn: "2020-01-03",
      },
    };
    expect(() =>
      validateEnrollmentChange(
        {
          ...payload,
          occurredOn: "2020-01-01",
          events: [{ ...payload.events[0]!, occurredOn: "2020-01-01" }],
        },
        {
          ...payload,
          occurredOn: "2020-01-01",
          events: [{ ...payload.events[0]!, occurredOn: "2020-01-01" }, last],
        },
        "doctor",
        Date.now(),
      ),
    ).toThrow("PARTICIPATION_CONSENT_EXPIRED");
  });
  it("replays once, prevents duplicate patient/project recruitment and preserves doctor correction rights", async () => {
    const { t, doctor, organizationId, projectClientId, args, apply, update } = await setup();
    expect(await apply(args)).toEqual({ revision: 1 });
    expect(await apply(args)).toEqual({ revision: 1 });
    await expect(
      apply({ ...args, clientId: crypto.randomUUID(), idempotencyKey: "duplicate" }),
    ).rejects.toThrow("ENROLLMENT_EXISTS");
    const enrolled = update(args.payload, "enrolled");
    await doctor.mutation(api.clinicalRecords.apply, enrolled);
    expect(await doctor.mutation(api.clinicalRecords.apply, enrolled)).toEqual({ revision: 2 });
    const foreign = t.withIdentity({ subject: "researcher" });
    expect(
      await foreign.query(api.clinicalRecords.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await expect(
      foreign.mutation(api.clinicalRecords.apply, { ...args, actorId: "researcher" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await expect(apply(args)).rejects.toThrow("ACCESS_DENIED");
    await expect(doctor.mutation(api.clinicalRecords.apply, enrolled)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await doctor.mutation(api.clinicalRecords.apply, update(enrolled.payload, "withdrawn", 2));
    const { payload: _payload, ...remove } = args;
    const current = (
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })
    )[0]!;
    await doctor.mutation(api.clinicalRecords.apply, {
      ...remove,
      action: "delete",
      expectedRevision: 3,
      expectedWriteId: current.payload?.kind === "enrollment" ? current.payload.writeId : null,
      idempotencyKey: "remove",
    });
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }))[0],
    ).toMatchObject({ deleted: true, payload: null });
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Confidential|Private|consent document/);
  });
  it("checks role, protocol, current ethics, recruitment and actor before creating or enrolling", async () => {
    const { t, doctor, projectClientId, protocolClientId, args, apply, update } = await setup();
    for (const actorId of ["viewer", "other"])
      await expect(
        t
          .withIdentity({ subject: actorId })
          .mutation(api.clinicalRecords.apply, { ...args, actorId }),
      ).rejects.toThrow("ACCESS_DENIED");
    await expect(apply({ ...args, actorId: "other" })).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      apply({ ...args, payload: { ...args.payload, protocolClientId: crypto.randomUUID() } }),
    ).rejects.toThrow("PROTOCOL_OUTDATED");
    await apply(args);
    const enrolled = update(args.payload, "enrolled");
    await t.run(async (ctx) => {
      const protocol = await ctx.db
        .query("studyProtocols")
        .withIndex("by_client", (q) => q.eq("clientId", protocolClientId))
        .unique();
      await ctx.db.patch(protocol!._id, { ethicsExpiresAt: Date.now() - 1 });
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, enrolled)).rejects.toThrow(
      "ETHICS_APPROVAL_REQUIRED",
    );
    await t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_client", (q) => q.eq("clientId", projectClientId))
        .unique();
      await ctx.db.patch(project!._id, { status: "preparing" });
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, enrolled)).rejects.toThrow(
      "RECRUITMENT_CLOSED",
    );
    await doctor.mutation(api.clinicalRecords.apply, update(args.payload, "declined"));
  });
  it("rejects overwritten history and wrong predecessor tokens", async () => {
    const { doctor, args, apply, update } = await setup();
    await apply(args);
    const enrolled = update(args.payload, "enrolled");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...enrolled,
        payload: {
          ...enrolled.payload,
          events: [
            { ...args.payload.events[0]!, reason: "Overwrite" },
            enrolled.payload.events[1]!,
          ],
        },
      }),
    ).rejects.toThrow("ENROLLMENT_HISTORY_IMMUTABLE");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...enrolled,
        expectedWriteId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const { expectedWriteId: _expectedWriteId, ...withoutPredecessor } = enrolled;
    await expect(doctor.mutation(api.clinicalRecords.apply, withoutPredecessor)).rejects.toThrow(
      "INVALID_CLINICAL_RECORD",
    );
  });
});

it("persists encrypted screening, competing inclusion chains and deletion across cold restarts", async () => {
  const { t, doctor, organizationId, projectClientId, patientClientId, payload, args, update } =
    await setup();
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
  const queued = await workspace.saveClinical({
    clientId: args.clientId,
    patientClientId,
    expectedRevision: 0,
    action: "create",
    payload,
  });
  const local = workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!)
    .payload as EnrollmentPayload;
  expect(calls).toBe(0);
  expect(JSON.stringify([...storage.values.values()])).not.toContain("Confidential");
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  expect(workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!).payload).toEqual(
    local,
  );
  expect(
    enrollmentRegister(
      [...workspace.collection.values()]
        .filter((row) => row.clientId !== workspace.patientSnapshotId)
        .map(workspace.read),
      [workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!)],
      projectClientId,
      "doctor",
      Date.now(),
    ),
  ).toMatchObject([{ fullName: "Private patient", status: "screening" }]);
  await refresh();
  const delivered = workspace.executor.waitForTransactionCompletion(queued.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await delivered;
  expect(calls).toBe(1);
  connection.disconnect();
  const localEnrolled = { ...local, events: [...local.events, nextEvent("enrolled")] };
  const a = await workspace.saveClinical({
    clientId: args.clientId,
    patientClientId,
    expectedRevision: 1,
    action: "update",
    payload: localEnrolled,
  });
  const a2 = workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!)
    .payload as EnrollmentPayload;
  const b = await workspace.saveClinical({
    clientId: args.clientId,
    patientClientId,
    expectedRevision: 2,
    action: "update",
    payload: { ...a2, events: [...a2.events, nextEvent("withdrawn")] },
  });
  const concurrent = update(local, "enrolled");
  await doctor.mutation(api.clinicalRecords.apply, concurrent);
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const settled = Promise.allSettled(
    [a, b].map((row) => workspace.executor.waitForTransactionCompletion(row.transactionId)),
  );
  connection.connect();
  workspace.setAuthenticated(true);
  expect((await settled).map((row) => row.status)).toEqual(["rejected", "rejected"]);
  const failures = await workspace.failedActions("clinical");
  expect(failures).toHaveLength(2);
  expect(failures.map((row) => row.code)).toEqual(["REVISION_CONFLICT", "REVISION_CONFLICT"]);
  expect(workspace.readClinical(failures[0]!.envelope).payload).toMatchObject({
    events: [{ status: "screening" }, { status: "enrolled" }],
  });
  expect(JSON.stringify([...failureStorage.values.values()])).not.toContain("Confidential");
  const current = workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!)
    .payload as EnrollmentPayload;
  expect(current.events).toHaveLength(2);
  expect(current.writeId).toBe(concurrent.payload.writeId);
  connection.disconnect();
  const completed = await workspace.saveClinical({
    clientId: args.clientId,
    patientClientId,
    expectedRevision: 2,
    action: "update",
    payload: { ...current, events: [...current.events, nextEvent("completed")] },
  });
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const complete = workspace.executor.waitForTransactionCompletion(completed.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await complete;
  connection.disconnect();
  const deleted = await workspace.saveClinical({
    clientId: args.clientId,
    patientClientId,
    expectedRevision: 3,
    action: "delete",
  });
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  expect(workspace.readClinical(workspace.clinicalRecords.get(args.clientId)!).payload).toBeNull();
  await refresh();
  const deletion = workspace.executor.waitForTransactionCompletion(deleted.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await deletion;
  expect(
    (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }))[0],
  ).toMatchObject({ deleted: true, payload: null, revision: 4 });
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const data = tables.flatMap((table) =>
    sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
  );
  expect(JSON.stringify(data)).not.toContain("Confidential");
  expect(await workspace.executor.peekOutbox()).toEqual([]);
  connection.disconnect();
  const stale = await workspace.saveClinical({
    clientId: crypto.randomUUID(),
    patientClientId,
    expectedRevision: 0,
    action: "create",
    payload,
  });
  await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_client", (q) => q.eq("clientId", projectClientId))
      .unique();
    await ctx.db.patch(project!._id, { status: "preparing" });
  });
  await workspace.close();
  snapshots = new Map();
  workspace = await open();
  await refresh();
  const staleSettled = workspace.executor.waitForTransactionCompletion(stale.transactionId);
  connection.connect();
  workspace.setAuthenticated(true);
  await expect(staleSettled).rejects.toThrow();
  expect(
    (await workspace.failedActions("clinical")).some((row) => row.code === "RECRUITMENT_CLOSED"),
  ).toBe(true);
  await workspace.close();
  sqlite.close();
});
