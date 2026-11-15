import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import { recruitmentJournal, recruitmentTotals } from "@/src/lib/recruitment-journal";
import type { RecruitmentJournalRecord } from "@/src/lib/recruitment-journal";
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";

const now = Date.parse("2026-11-14T12:00:00Z");
const today = () => new Date().toISOString().slice(0, 10);
const future = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
function event(
  status: EnrollmentStatus,
  occurredOn: string,
  recordedAt: number,
  expiresOn: string,
  recordedBy = "doctor",
) {
  return {
    id: crypto.randomUUID(),
    status,
    occurredOn,
    reason: `Private ${status} reason`,
    recordedBy,
    recordedAt,
    eligibilityEvidence: status === "enrolled" ? "Private eligibility evidence" : "",
    inclusionConfirmed: status === "enrolled",
    exclusionAbsent: status === "enrolled",
    consent:
      status === "enrolled"
        ? {
            documentReference: "Hidden document reference",
            version: "1",
            signedOn: occurredOn,
            expiresOn,
          }
        : null,
  };
}
function payload(
  statuses: readonly EnrollmentStatus[],
  projectClientId: string,
  expiresOn: string,
) {
  const occurred: Record<EnrollmentStatus, string> = {
    screening: "2026-11-01",
    ineligible: "2026-11-02",
    enrolled: "2026-11-02",
    declined: "2026-11-02",
    withdrawn: "2026-11-03",
    completed: "2026-11-03",
  };
  return {
    kind: "enrollment",
    writeId: crypto.randomUUID(),
    projectClientId,
    protocolClientId: crypto.randomUUID(),
    protocolVersion: 1,
    occurredOn: "2026-11-01",
    notes: "Private enrollment note",
    events: statuses.map((status) =>
      event(status, occurred[status], Date.parse(`${occurred[status]}T12:00:00Z`), expiresOn),
    ),
  } satisfies EnrollmentPayload;
}
function record(
  organizationId: string,
  statuses: readonly EnrollmentStatus[],
  projectClientId: string,
  overrides: Partial<RecruitmentJournalRecord> = {},
  expiresOn = "2026-11-20",
): RecruitmentJournalRecord {
  return {
    organizationId,
    deleted: false,
    updatedAt: statuses.length,
    payload: payload(statuses, projectClientId, expiresOn),
    ...overrides,
  };
}
const project = crypto.randomUUID();
const organizations = new Map([
  ["org-b", { name: "Beta Hospital", country: "RU", city: "Kazan" }],
  ["org-a", { name: "Alpha Clinic", country: "RU", city: "Samara" }],
]);
describe("multi-center recruitment journal model", () => {
  it("aggregates current decisions per center without patient identity", () => {
    const rows = recruitmentJournal(
      [
        record("org-b", ["screening", "enrolled"], project),
        record("org-b", ["screening", "declined"], project),
        record("org-a", ["screening"], project),
        record("org-a", ["screening", "enrolled", "withdrawn"], project),
      ],
      organizations,
      project,
      now,
    );
    expect(rows.map((row) => row.organizationId)).toEqual(["org-a", "org-b"]);
    expect(rows[0]).toMatchObject({
      name: "Alpha Clinic",
      counts: { screening: 1, ineligible: 0, enrolled: 0, declined: 0, withdrawn: 1, completed: 0 },
      total: 2,
      consentExpired: 0,
    });
    expect(rows[1]).toMatchObject({
      name: "Beta Hospital",
      counts: { screening: 0, ineligible: 0, enrolled: 1, declined: 1, withdrawn: 0, completed: 0 },
      total: 2,
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /Private|Hidden|documentReference|patientClientId|reason/,
    );
    expect(recruitmentTotals(rows)).toEqual({
      counts: { screening: 1, ineligible: 0, enrolled: 1, declined: 1, withdrawn: 1, completed: 0 },
      total: 4,
      consentExpired: 0,
      centers: 2,
    });
  });
  it("excludes deleted rows, other projects and other record kinds", () => {
    const rows = recruitmentJournal(
      [
        record("org-a", ["screening"], project, { deleted: true, payload: null }),
        record("org-a", ["screening"], crypto.randomUUID()),
        {
          ...record("org-a", ["screening"], project),
          payload: { kind: "history", occurredOn: "2026-11-01", notes: "", text: "Private text" },
        },
      ],
      organizations,
      project,
      now,
    );
    expect(rows).toEqual([]);
    expect(recruitmentTotals(rows)).toEqual({
      counts: { screening: 0, ineligible: 0, enrolled: 0, declined: 0, withdrawn: 0, completed: 0 },
      total: 0,
      consentExpired: 0,
      centers: 0,
    });
  });
  it("counts expired consent only for current participants with an inclusive expiration date", () => {
    const rows = recruitmentJournal(
      [
        record("org-a", ["screening", "enrolled"], project, {}, "2026-11-13"),
        record("org-a", ["screening", "enrolled"], project, {}, "2026-11-14"),
        record("org-a", ["screening", "enrolled", "withdrawn"], project, {}, "2026-11-13"),
      ],
      organizations,
      project,
      now,
    );
    expect(rows[0]).toMatchObject({
      consentExpired: 1,
      counts: { enrolled: 2, withdrawn: 1 },
    });
  });
  it("keeps centers without directory entries and orders deterministically", () => {
    const rows = recruitmentJournal(
      [record("org-missing", ["screening"], project), record("org-a", ["screening"], project)],
      organizations,
      project,
      now,
    );
    expect(rows.map((row) => row.organizationId)).toEqual(["org-missing", "org-a"]);
    expect(rows[0]).toMatchObject({ name: "", country: "", city: "" });
  });
});

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/recruitment.ts": () => import("@/convex/recruitment"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const orgA = await t.mutation(internal.provisioning.createOrganization, {
    name: "Alpha Clinic",
    kind: "clinic",
    country: "RU",
    city: "Samara",
    description: "",
    published: false,
  });
  const orgB = await t.mutation(internal.provisioning.createOrganization, {
    name: "Beta Hospital",
    kind: "hospital",
    country: "RU",
    city: "Kazan",
    description: "",
    published: false,
  });
  for (const [userId, organizationId, role] of [
    ["doctor-a", orgA, "doctor"],
    ["viewer", orgA, "researcher"],
    ["doctor-b", orgB, "doctor"],
    ["outsider", orgB, "researcher"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, organizationId, role });
  const projectClientId = crypto.randomUUID();
  const protocolClientId = crypto.randomUUID();
  const doctorA = t.withIdentity({ subject: "doctor-a" });
  await doctorA.mutation(api.projects.apply, {
    actorId: "doctor-a",
    organizationId: orgA,
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
    const projectRow = (await ctx.db.query("projects").collect())[0]!;
    await ctx.db.patch(projectRow._id, { status: "recruiting" });
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
      createdBy: "doctor-a",
    });
    for (const [userId, organizationId, role] of [
      ["viewer", orgA, "viewer"],
      ["doctor-b", orgB, "member"],
    ] as const)
      await ctx.db.insert("projectMembers", {
        clientId: crypto.randomUUID(),
        projectClientId,
        userId,
        organizationId,
        role,
        active: true,
        revision: 1,
      });
  });
  async function addEnrollment(
    actorId: string,
    organizationId: Id<"organizations">,
    statuses: readonly EnrollmentStatus[],
  ) {
    const actor = t.withIdentity({ subject: actorId });
    const patientClientId = crypto.randomUUID();
    const recordClientId = crypto.randomUUID();
    await actor.mutation(api.patients.apply, {
      actorId,
      organizationId,
      clientId: patientClientId,
      action: "create",
      expectedRevision: 0,
      idempotencyKey: crypto.randomUUID(),
      values: {
        fullName: "Private patient",
        birthDate: "1990-01-01",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
      },
    });
    let current: EnrollmentPayload = {
      ...payload(["screening"], projectClientId, future()),
      occurredOn: today(),
      protocolClientId,
      events: [event("screening", today(), Date.now(), future(), actorId)],
    };
    let writeId: string | null = null;
    for (const [index, status] of statuses.entries()) {
      if (index > 0)
        current = {
          ...current,
          writeId: crypto.randomUUID(),
          events: [...current.events, event(status, today(), Date.now(), future(), actorId)],
        };
      await actor.mutation(api.clinicalRecords.apply, {
        actorId,
        organizationId,
        clientId: recordClientId,
        patientClientId,
        action: index === 0 ? "create" : "update",
        expectedRevision: index,
        expectedWriteId: writeId,
        payload: current,
        idempotencyKey: crypto.randomUUID(),
      });
      writeId = current.writeId;
    }
    return { patientClientId, recordClientId, writeId };
  }
  return { t, orgA, orgB, projectClientId, protocolClientId, addEnrollment };
}
describe("multi-center recruitment journal access", () => {
  it("serves per-center aggregates to active project members only", async () => {
    const { t, orgA, orgB, projectClientId, addEnrollment } = await setup();
    await addEnrollment("doctor-a", orgA, ["screening", "enrolled"]);
    const declined = await addEnrollment("doctor-a", orgA, ["screening", "declined"]);
    await addEnrollment("doctor-b", orgB, ["screening"]);
    await addEnrollment("doctor-b", orgB, ["screening", "enrolled"]);
    const viewer = t.withIdentity({ subject: "viewer" });
    const rows = await viewer.query(api.recruitment.centers, {
      projectClientId,
      actorId: "viewer",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organizationId: orgA,
      name: "Alpha Clinic",
      city: "Samara",
      counts: { screening: 0, ineligible: 0, enrolled: 1, declined: 1, withdrawn: 0, completed: 0 },
      total: 2,
      consentExpired: 0,
    });
    expect(rows[1]).toMatchObject({
      organizationId: orgB,
      name: "Beta Hospital",
      counts: { screening: 1, enrolled: 1 },
      total: 2,
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /Private|Hidden|documentReference|patientClientId|reason|writeId/,
    );
    await t.withIdentity({ subject: "doctor-a" }).mutation(api.clinicalRecords.apply, {
      actorId: "doctor-a",
      organizationId: orgA,
      clientId: declined.recordClientId,
      patientClientId: declined.patientClientId,
      action: "delete",
      expectedRevision: 2,
      expectedWriteId: declined.writeId,
      idempotencyKey: crypto.randomUUID(),
    });
    const after = await viewer.query(api.recruitment.centers, {
      projectClientId,
      actorId: "viewer",
    });
    expect(after[0]).toMatchObject({
      counts: { screening: 0, ineligible: 0, enrolled: 1, declined: 0, withdrawn: 0, completed: 0 },
      total: 1,
    });
    await expect(
      viewer.query(api.recruitment.centers, { projectClientId, actorId: "outsider" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      t
        .withIdentity({ subject: "outsider" })
        .query(api.recruitment.centers, { projectClientId, actorId: "outsider" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      viewer.query(api.recruitment.centers, {
        projectClientId: crypto.randomUUID(),
        actorId: "viewer",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});
