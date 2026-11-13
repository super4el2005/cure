import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { QuestionnairePayload } from "@/src/lib/study-form-model";
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/studyForms.ts": () => import("@/convex/studyForms"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const organization = {
    name: "Clinic",
    kind: "clinic" as const,
    country: "RU",
    city: "",
    description: "",
    published: false,
  };
  const clinic = await t.mutation(internal.provisioning.createOrganization, organization);
  const university = await t.mutation(internal.provisioning.createOrganization, {
    ...organization,
    name: "University",
    kind: "university",
  });
  for (const [userId, organizationId, role] of [
    ["researcher", university, "researcher"],
    ["researcher", clinic, "researcher"],
    ["doctor", clinic, "doctor"],
    ["viewer", clinic, "doctor"],
    ["other", clinic, "doctor"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, organizationId, role });
  const researcher = t.withIdentity({ subject: "researcher" });
  const doctor = t.withIdentity({ subject: "doctor" });
  const projectClientId = crypto.randomUUID();
  await researcher.mutation(api.projects.apply, {
    actorId: "researcher",
    organizationId: university,
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
  await t.run(async (ctx) => {
    for (const userId of ["doctor", "viewer"])
      await ctx.db.insert("projectMembers", {
        clientId: crypto.randomUUID(),
        projectClientId,
        userId,
        organizationId: clinic,
        role: userId === "doctor" ? "member" : "viewer",
        active: true,
        revision: 1,
      });
  });
  const patientClientId = crypto.randomUUID();
  await doctor.mutation(api.patients.apply, {
    actorId: "doctor",
    organizationId: clinic,
    clientId: patientClientId,
    expectedRevision: 0,
    action: "create",
    idempotencyKey: "patient",
    values: {
      fullName: "Private patient",
      birthDate: "1990-01-01",
      sex: "unknown",
      diagnosisCodes: [],
      notes: "",
    },
  });
  const boolId = crypto.randomUUID();
  const numberId = crypto.randomUUID();
  const definition = {
    title: "Private form title",
    description: "",
    fields: [
      {
        id: boolId,
        type: "boolean" as const,
        label: "Private clinical question",
        help: "",
        required: true,
      },
      {
        id: numberId,
        type: "number" as const,
        label: "Recorded value",
        help: "",
        required: true,
        minimum: 0,
        maximum: 100,
        unit: "unit",
      },
    ],
  };
  const formArgs = {
    actorId: "researcher",
    organizationId: university,
    projectClientId,
    formClientId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    expectedVersion: 0,
    baseVersionClientId: null,
    definition,
    status: "published" as const,
    idempotencyKey: "form",
  };
  await researcher.mutation(api.studyForms.append, formArgs);
  const payload: QuestionnairePayload = {
    kind: "questionnaire",
    writeId: crypto.randomUUID(),
    occurredOn: "2026-01-01",
    notes: "Private note",
    projectClientId,
    formClientId: formArgs.formClientId,
    formVersionClientId: formArgs.clientId,
    formVersion: 1,
    definition,
    answers: {},
    status: "draft",
    amendmentReason: "",
  };
  const args = {
    actorId: "doctor",
    organizationId: clinic,
    patientClientId,
    clientId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "create" as const,
    expectedWriteId: null as string | null,
    payload,
    idempotencyKey: "response",
  };
  const apply = async (input: FunctionArgs<typeof api.clinicalRecords.apply>) => {
    const previous =
      input.action === "create"
        ? null
        : await t.run((ctx) =>
            ctx.db
              .query("clinicalRecords")
              .withIndex("by_client", (q) =>
                q.eq("organizationId", clinic).eq("clientId", input.clientId),
              )
              .unique(),
          );
    return doctor.mutation(api.clinicalRecords.apply, {
      ...input,
      expectedWriteId:
        previous?.payload?.kind === "questionnaire" ? previous.payload.writeId : null,
      ...(input.payload?.kind === "questionnaire" && input.action !== "create"
        ? { payload: { ...input.payload, writeId: crypto.randomUUID() } }
        : {}),
    });
  };
  return { t, doctor, researcher, clinic, university, args, formArgs, boolId, numberId, apply };
}
describe("questionnaire clinical permissions and version binding", () => {
  it("lets a doctor finalize and amend answers without granting a template author clinical access", async () => {
    const { t, doctor, researcher, clinic, args, boolId, numberId, apply } = await setup();
    await apply(args);
    await expect(
      apply({
        ...args,
        clientId: crypto.randomUUID(),
        payload: { ...args.payload, status: "final" },
        idempotencyKey: "incomplete",
      }),
    ).rejects.toThrow("INVALID_CLINICAL_RECORD");
    const final = {
      ...args.payload,
      status: "final" as const,
      answers: { [boolId]: false, [numberId]: 0 },
    };
    await apply({
      ...args,
      action: "update",
      expectedRevision: 1,
      payload: final,
      idempotencyKey: "finalize",
    });
    await expect(
      apply({
        ...args,
        action: "update",
        expectedRevision: 2,
        idempotencyKey: "reopen",
      }),
    ).rejects.toThrow("FINAL_ANSWER_IMMUTABLE");
    await expect(
      apply({
        ...args,
        action: "update",
        expectedRevision: 2,
        payload: { ...final, notes: "Correction" },
        idempotencyKey: "without-reason",
      }),
    ).rejects.toThrow("AMENDMENT_REASON_REQUIRED");
    await apply({
      ...args,
      action: "update",
      expectedRevision: 2,
      payload: { ...final, notes: "Correction", amendmentReason: "Documented correction" },
      idempotencyKey: "amend",
    });
    expect(
      await researcher.query(api.clinicalRecords.list, {
        actorId: "researcher",
        organizationId: clinic,
      }),
    ).toEqual([]);
    await expect(
      researcher.mutation(api.clinicalRecords.apply, { ...args, actorId: "researcher" }),
    ).rejects.toThrow("ACCESS_DENIED");
    const rows = await doctor.query(api.clinicalRecords.list, {
      actorId: "doctor",
      organizationId: clinic,
    });
    expect(rows[0]).toMatchObject({
      revision: 3,
      payload: { status: "final", answers: { [boolId]: false, [numberId]: 0 } },
    });
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Private|Correction|Documented/);
  });
  it("checks the authoritative template, exact organization and project participation", async () => {
    const { t, doctor, args, formArgs, clinic, university, apply } = await setup();
    await expect(
      apply({
        ...args,
        payload: {
          ...args.payload,
          definition: { ...args.payload.definition, title: "Forged form" },
        },
      }),
    ).rejects.toThrow("INVALID_STUDY_FORM");
    await expect(
      apply({
        ...args,
        payload: { ...args.payload, answers: { unknown: "Hidden data" } },
      }),
    ).rejects.toThrow("INVALID_CLINICAL_RECORD");
    await expect(
      t
        .withIdentity({ subject: "viewer" })
        .mutation(api.clinicalRecords.apply, { ...args, actorId: "viewer" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      t
        .withIdentity({ subject: "other" })
        .mutation(api.clinicalRecords.apply, { ...args, actorId: "other" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "doctor",
      organizationId: university,
      role: "doctor",
    });
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", formArgs.projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { organizationId: university });
    });
    await expect(apply({ ...args, organizationId: clinic })).rejects.toThrow("ACCESS_DENIED");
  });
  it("rejects new responses to outdated/retired versions but preserves receipt replay and old response corrections", async () => {
    const { doctor, researcher, args, formArgs, apply } = await setup();
    await apply(args);
    const next = {
      ...formArgs,
      clientId: crypto.randomUUID(),
      expectedVersion: 1,
      baseVersionClientId: formArgs.clientId,
      definition: { ...formArgs.definition, title: "New version" },
      idempotencyKey: "next-form",
    };
    await researcher.mutation(api.studyForms.append, next);
    expect(await apply(args)).toEqual({ revision: 1 });
    await expect(
      apply({
        ...args,
        clientId: crypto.randomUUID(),
        idempotencyKey: "stale-new",
      }),
    ).rejects.toThrow("FORM_VERSION_OUTDATED");
    await expect(
      apply({
        ...args,
        action: "update",
        expectedRevision: 1,
        payload: {
          ...args.payload,
          formVersion: 2,
          formVersionClientId: next.clientId,
          definition: next.definition,
        },
        idempotencyKey: "move-version",
      }),
    ).rejects.toThrow("FORM_VERSION_IMMUTABLE");
    await apply({
      ...args,
      action: "update",
      expectedRevision: 1,
      payload: { ...args.payload, notes: "Historical correction" },
      idempotencyKey: "old-correction",
    });
    const retired = {
      ...next,
      clientId: crypto.randomUUID(),
      expectedVersion: 2,
      baseVersionClientId: next.clientId,
      status: "retired" as const,
      idempotencyKey: "retire",
    };
    await researcher.mutation(api.studyForms.append, retired);
    await expect(
      apply({
        ...args,
        clientId: crypto.randomUUID(),
        payload: {
          ...args.payload,
          formVersion: 3,
          formVersionClientId: retired.clientId,
          definition: retired.definition,
        },
        idempotencyKey: "retired-new",
      }),
    ).rejects.toThrow("FORM_VERSION_OUTDATED");
  });
  it("rechecks revoked project participation before receipt replay and still lets the clinic delete its record", async () => {
    const { t, doctor, args, formArgs, clinic, apply } = await setup();
    await apply(args);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", formArgs.projectClientId).eq("userId", "doctor"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await expect(apply(args)).rejects.toThrow("ACCESS_DENIED");
    const { payload: _payload, ...remove } = args;
    await apply({
      ...remove,
      action: "delete",
      expectedRevision: 1,
      idempotencyKey: "delete",
    });
    expect(
      (
        await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId: clinic })
      )[0],
    ).toMatchObject({ deleted: true, payload: null });
  });
});
