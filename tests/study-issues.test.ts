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
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import {
  studyIssuePayloadSchema,
  validateStudyIssueWrite,
  issueOverdue,
} from "@/src/lib/study-issue-model";
import type { StudyIssuePayload } from "@/src/lib/study-issue-model";
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

async function safetySetup(type: "adverseEvent" | "deviation" = "adverseEvent") {
  const context = await setup();
  await context.apply(context.args);
  const payload: StudyIssuePayload = {
    kind: "studyIssue",
    writeId: crypto.randomUUID(),
    projectClientId: context.projectClientId,
    enrollmentClientId: context.args.clientId,
    protocolClientId: context.protocolClientId,
    protocolVersion: 1,
    occurredOn: today(),
    detectedOn: today(),
    title: "Confidential safety event",
    description: "Confidential clinical description",
    notes: "Confidential safety note",
    status: "open",
    reviewerId: "doctor",
    reviewDueOn: today(),
    resolution: "",
    reviewedOn: "",
    reviewedBy: "",
    amendmentReason: "",
    details:
      type === "adverseEvent"
        ? {
            type: "adverseEvent",
            severity: "severe",
            seriousness: [],
            causality: "unassessed",
            expectedness: "unknown",
            suspectAgent: "",
            actionTaken: "Confidential clinical actions",
            outcome: "ongoing",
            endedOn: "",
          }
        : {
            type: "deviation",
            impact: "major",
            protocolSection: "Private protocol section",
            rootCause: "",
            correctiveAction: "",
            preventiveAction: "",
          },
  };
  const args = {
    ...context.args,
    clientId: crypto.randomUUID(),
    payload,
    idempotencyKey: "safety-case",
  };
  const change = (previous: StudyIssuePayload, revision = 1) => ({
    ...args,
    action: "update" as const,
    expectedRevision: revision,
    expectedWriteId: previous.writeId,
    payload: { ...previous, writeId: crypto.randomUUID() },
    idempotencyKey: crypto.randomUUID(),
  });
  return { ...context, args, payload, change };
}
describe("clinical study issue classification and reviewer authority", () => {
  it("keeps severity separate from seriousness and validates outcomes, dates and corrective actions", async () => {
    const { payload } = await safetySetup();
    expect(studyIssuePayloadSchema.safeParse(payload).success).toBe(true);
    if (payload.details.type !== "adverseEvent") throw new Error("FIXTURE");
    expect(
      studyIssuePayloadSchema.safeParse({
        ...payload,
        details: { ...payload.details, outcome: "fatal", endedOn: today() },
      }).success,
    ).toBe(false);
    expect(
      studyIssuePayloadSchema.safeParse({
        ...payload,
        details: { ...payload.details, outcome: "fatal", endedOn: today(), seriousness: ["death"] },
      }).success,
    ).toBe(true);
    expect(
      studyIssuePayloadSchema.safeParse({
        ...payload,
        details: { ...payload.details, outcome: "ongoing", endedOn: today() },
      }).success,
    ).toBe(false);
    expect(
      studyIssuePayloadSchema.safeParse({ ...payload, detectedOn: "2000-01-01" }).success,
    ).toBe(false);
    expect(() =>
      validateStudyIssueWrite(null, { ...payload, detectedOn: future() }, "doctor", Date.now()),
    ).toThrow("INVALID_CLINICAL_DATE");
    expect(issueOverdue({ ...payload, reviewDueOn: today() }, Date.now())).toBe(false);
    expect(issueOverdue({ ...payload, reviewDueOn: "2000-01-01" }, Date.now())).toBe(true);
    const deviation = (await safetySetup("deviation")).payload;
    expect(
      studyIssuePayloadSchema.safeParse({
        ...deviation,
        status: "resolved",
        resolution: "Reviewed",
        reviewedOn: today(),
        reviewedBy: "doctor",
      }).success,
    ).toBe(false);
  });
  it("allows safety reporting without current project participation and keeps medical records private to clinic physicians", async () => {
    const { t, doctor, organizationId, projectClientId, args } = await safetySetup();
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
      const project = await ctx.db
        .query("projects")
        .withIndex("by_client", (q) => q.eq("clientId", projectClientId))
        .unique();
      await ctx.db.patch(project!._id, { status: "archived" });
    });
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    const other = t.withIdentity({ subject: "other" });
    await other.mutation(api.clinicalRecords.apply, {
      ...args,
      clientId: crypto.randomUUID(),
      actorId: "other",
      idempotencyKey: "other-physician",
    });
    const researcher = t.withIdentity({ subject: "researcher" });
    expect(
      await researcher.query(api.clinicalRecords.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await expect(
      researcher.mutation(api.clinicalRecords.apply, { ...args, actorId: "researcher" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      researcher.query(api.clinicalRecords.reviewers, { actorId: "researcher", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(
      (await doctor.query(api.clinicalRecords.reviewers, { actorId: "doctor", organizationId }))
        .map((row) => row.userId)
        .sort(),
    ).toEqual(["doctor", "other", "viewer"]);
  });
  it("checks real participant binding and rejects invalid assignees, reviewer impersonation and terminal reopening", async () => {
    const { t, doctor, organizationId, args, change } = await safetySetup();
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, enrollmentClientId: crypto.randomUUID() },
      }),
    ).rejects.toThrow("PARTICIPATION_INACTIVE");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, reviewerId: "researcher" },
      }),
    ).rejects.toThrow("ISSUE_REVIEWER_UNAVAILABLE");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, protocolVersion: 2 },
      }),
    ).rejects.toThrow("ISSUE_BINDING_IMMUTABLE");
    await doctor.mutation(api.clinicalRecords.apply, args);
    const reviewing = {
      ...change(args.payload),
      payload: { ...args.payload, writeId: crypto.randomUUID(), status: "underReview" as const },
    };
    await expect(
      t
        .withIdentity({ subject: "other" })
        .mutation(api.clinicalRecords.apply, { ...reviewing, actorId: "other" }),
    ).rejects.toThrow("ISSUE_REVIEWER_REQUIRED");
    await doctor.mutation(api.clinicalRecords.apply, reviewing);
    const resolved = {
      ...change(reviewing.payload, 2),
      payload: {
        ...reviewing.payload,
        writeId: crypto.randomUUID(),
        status: "resolved" as const,
        reviewedOn: today(),
        reviewedBy: "doctor",
        resolution: "Confidential assessment",
      },
    };
    await doctor.mutation(api.clinicalRecords.apply, resolved);
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...change(resolved.payload, 3),
        payload: { ...resolved.payload, writeId: crypto.randomUUID(), notes: "Changed" },
      }),
    ).rejects.toThrow("AMENDMENT_REASON_REQUIRED");
    const amended = {
      ...change(resolved.payload, 3),
      payload: {
        ...resolved.payload,
        writeId: crypto.randomUUID(),
        notes: "Reviewed correction",
        amendmentReason: "Additional clinical evidence",
      },
    };
    await t
      .withIdentity({ subject: "other" })
      .mutation(api.clinicalRecords.apply, { ...amended, actorId: "other" });
    const closed = {
      ...change(amended.payload, 4),
      payload: {
        ...amended.payload,
        writeId: crypto.randomUUID(),
        status: "closed" as const,
        amendmentReason: "Closure confirmed",
      },
    };
    await doctor.mutation(api.clinicalRecords.apply, closed);
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...change(closed.payload, 5),
        payload: {
          ...closed.payload,
          writeId: crypto.randomUUID(),
          status: "open",
          reviewedOn: "",
          reviewedBy: "",
          resolution: "",
          amendmentReason: "Attempt to reopen",
        },
      }),
    ).rejects.toThrow("INVALID_ISSUE_TRANSITION");
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Confidential|Reviewed correction|clinical evidence/);
  });
});

it.each(["adverseEvent", "deviation"] as const)(
  "restores encrypted %s cases, rejects dependent conflicts and preserves reviewer refusal",
  async (type) => {
    const { t, doctor, organizationId, patientClientId, args, payload, change } =
      await safetySetup(type);
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
    await workspace.cacheReviewers([{ userId: "doctor", displayName: "Private reviewer name" }]);
    const id = args.clientId;
    const queued = await workspace.saveClinical({
      clientId: id,
      patientClientId,
      expectedRevision: 0,
      action: "create",
      payload,
    });
    const local = workspace.readClinical(workspace.clinicalRecords.get(id)!)
      .payload as StudyIssuePayload;
    expect(calls).toBe(0);
    expect(JSON.stringify([...storage.values.values()])).not.toContain("Confidential");
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    expect(workspace.readClinical(workspace.clinicalRecords.get(id)!).payload).toEqual(local);
    expect(await workspace.cachedReviewers()).toEqual([
      { userId: "doctor", displayName: "Private reviewer name" },
    ]);
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
      payload: { ...local, description: "Confidential competing description" },
    });
    const a2 = workspace.readClinical(workspace.clinicalRecords.get(id)!)
      .payload as StudyIssuePayload;
    const b = await workspace.saveClinical({
      clientId: id,
      patientClientId,
      expectedRevision: 2,
      action: "update",
      payload: { ...a2, notes: "Confidential dependent note" },
    });
    await doctor.mutation(api.clinicalRecords.apply, {
      ...change(local),
      payload: {
        ...local,
        writeId: crypto.randomUUID(),
        description: "Authoritative case description",
      },
    });
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
      .payload as StudyIssuePayload;
    const reviewed = {
      ...current,
      status: "resolved" as const,
      reviewedOn: today(),
      reviewedBy: "doctor",
      resolution: "Confidential assessment",
      details:
        current.details.type === "deviation"
          ? {
              ...current.details,
              rootCause: "Reviewed root cause",
              correctiveAction: "Documented corrective action",
              preventiveAction: "Documented preventive action",
            }
          : current.details,
    };
    const completion = await workspace.saveClinical({
      clientId: id,
      patientClientId,
      expectedRevision: 2,
      action: "update",
      payload: reviewed,
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await refresh();
    const resolved = workspace.executor.waitForTransactionCompletion(completion.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await resolved;
    connection.disconnect();
    const pending = await workspace.saveClinical({
      clientId: crypto.randomUUID(),
      patientClientId,
      expectedRevision: 0,
      action: "create",
      payload: { ...payload, reviewerId: "viewer" },
    });
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", "viewer"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await workspace.close();
    snapshots = new Map();
    workspace = await open();
    await refresh();
    const denied = workspace.executor.waitForTransactionCompletion(pending.transactionId);
    connection.connect();
    workspace.setAuthenticated(true);
    await expect(denied).rejects.toThrow();
    expect(
      (await workspace.failedActions("clinical")).some(
        (row) => row.code === "ISSUE_REVIEWER_UNAVAILABLE",
      ),
    ).toBe(true);
    connection.disconnect();
    const envelope = workspace.clinicalRecords.get(id)!;
    const deleted = await workspace.saveClinical({
      clientId: id,
      patientClientId,
      expectedRevision: envelope.revision,
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
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(
      JSON.stringify(
        tables.flatMap((table) =>
          sqlite.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all(),
        ),
      ),
    ).not.toMatch(/Confidential|Private reviewer name/);
    await workspace.close();
    sqlite.close();
  },
);
