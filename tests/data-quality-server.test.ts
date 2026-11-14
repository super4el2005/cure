import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { qualityReviewPayloadSchema } from "@/src/lib/data-quality-model";
import { analyzePatientQuality } from "@/src/lib/patient-data-quality";
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "Clinic",
    kind: "clinic",
    country: "RU",
    city: "",
    description: "",
    published: true,
  });
  for (const [userId, role] of [
    ["doctor", "doctor"],
    ["researcher", "researcher"],
    ["admin", "admin"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, role, organizationId });
  const doctor = t.withIdentity({ subject: "doctor" });
  const patientId = crypto.randomUUID();
  const patient = {
    actorId: "doctor",
    organizationId,
    clientId: patientId,
    expectedRevision: 0,
    action: "create" as const,
    idempotencyKey: "patient",
    values: {
      fullName: "Private patient",
      birthDate: "1990-01-01",
      sex: "unknown" as const,
      diagnosisCodes: [],
      notes: "",
    },
  };
  await doctor.mutation(api.patients.apply, patient);
  const patientRow = (
    await doctor.query(api.patients.list, { actorId: "doctor", organizationId })
  )[0]!;
  const day = new Date().toISOString().slice(0, 10);
  const report = analyzePatientQuality(patientRow, [], day);
  const finding = report.findings.find((finding) => finding.code === "allergiesUndocumented")!;
  const payload = qualityReviewPayloadSchema.parse({
    kind: "qualityReview",
    writeId: crypto.randomUUID(),
    occurredOn: day,
    notes: "Private review note",
    algorithmVersion: "patient-quality-v1",
    evaluationDate: day,
    sourceSignature: report.sourceSignature,
    findingKey: finding.key,
    code: finding.code,
    decision: "needsClarification",
    reviewedBy: "doctor",
  });
  const args = {
    actorId: "doctor",
    organizationId,
    patientClientId: patientId,
    clientId: crypto.randomUUID(),
    expectedRevision: 0,
    expectedWriteId: null,
    historyId: crypto.randomUUID(),
    expectedHistoryId: null,
    action: "create" as const,
    payload,
    idempotencyKey: "quality-review",
  };
  return { t, doctor, organizationId, patient, args };
}
describe("authoritative quality review snapshots", () => {
  it("persists one immutable review and its content history with idempotent replay and safe audit", async () => {
    const { t, doctor, organizationId, args } = await setup();
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    const rows = await doctor.query(api.clinicalRecords.list, {
      actorId: "doctor",
      organizationId,
    });
    expect(rows).toHaveLength(1);
    expect(clinicalRecordSchema.parse(rows[0]).payload).toEqual(args.payload);
    const versions = await doctor.query(api.clinicalRecords.versions, {
      actorId: "doctor",
      organizationId,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.payload).toEqual(args.payload);
    expect(
      JSON.stringify(await t.run((ctx) => ctx.db.query("clinicalAudit").collect())),
    ).not.toMatch(/Private|sourceSignature|findingKey/);
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        expectedRevision: 1,
        expectedHistoryId: args.historyId,
        historyId: crypto.randomUUID(),
        expectedWriteId: args.payload.writeId,
        action: "update",
        payload: { ...args.payload, writeId: crypto.randomUUID(), notes: "Rewritten" },
        idempotencyKey: "rewrite",
      }),
    ).rejects.toThrow("QUALITY_REVIEW_IMMUTABLE");
  });
  it("recomputes the complete source and rejects a stale clinical or patient snapshot", async () => {
    const { doctor, organizationId, patient, args } = await setup();
    await doctor.mutation(api.clinicalRecords.apply, {
      actorId: "doctor",
      organizationId,
      patientClientId: patient.clientId,
      clientId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "create",
      payload: { kind: "history", occurredOn: "2020-01-01", notes: "", text: "New source" },
      idempotencyKey: "new-source",
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, args)).rejects.toThrow(
      "QUALITY_SOURCE_CHANGED",
    );
  });
  it("requires a real computed finding and denies other roles and actors", async () => {
    const { t, doctor, organizationId, args } = await setup();
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, findingKey: "forged" },
      }),
    ).rejects.toThrow("INVALID_QUALITY_REVIEW");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        payload: { ...args.payload, reviewedBy: "another-doctor" },
      }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    for (const userId of ["researcher", "admin"]) {
      const actor = t.withIdentity({ subject: userId });
      await expect(
        actor.mutation(api.clinicalRecords.apply, { ...args, actorId: userId }),
      ).rejects.toThrow("ACCESS_DENIED");
      if (userId === "researcher")
        expect(
          await actor.query(api.clinicalRecords.list, { actorId: userId, organizationId }),
        ).toEqual([]);
    }
  });
  it("allows an old successful receipt without reattesting changed data, but checks revoked rights first", async () => {
    const { t, doctor, organizationId, patient, args } = await setup();
    await doctor.mutation(api.clinicalRecords.apply, args);
    await doctor.mutation(api.patients.apply, {
      ...patient,
      action: "update",
      expectedRevision: 1,
      values: { ...patient.values, notes: "Changed source" },
      idempotencyKey: "patient-update",
    });
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, args)).rejects.toThrow("ACCESS_DENIED");
  });
  it("rejects a changed patient snapshot before saving any review", async () => {
    const { doctor, organizationId, patient, args } = await setup();
    await doctor.mutation(api.patients.apply, {
      ...patient,
      action: "update",
      expectedRevision: 1,
      values: { ...patient.values, notes: "Changed documentation" },
      idempotencyKey: "changed-patient",
    });
    await expect(doctor.mutation(api.clinicalRecords.apply, args)).rejects.toThrow(
      "QUALITY_SOURCE_CHANGED",
    );
    expect(
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }),
    ).toEqual([]);
  });
});
