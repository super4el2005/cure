import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import {
  formAnswersSchema,
  formDefinitionSchema,
  normalizeFormAnswers,
  questionnairePayloadSchema,
} from "@/src/lib/study-form-model";
import type { FormDefinition, StudyField } from "@/src/lib/study-form-model";

function definition(): FormDefinition {
  const common = { label: "Question", help: "", required: true };
  return {
    title: "Private research form",
    description: "Private definition",
    fields: [
      { ...common, id: crypto.randomUUID(), type: "text", maxLength: 10 },
      { ...common, id: crypto.randomUUID(), type: "number", minimum: 0, maximum: 10, unit: "unit" },
      {
        ...common,
        id: crypto.randomUUID(),
        type: "date",
        minDate: "2020-01-01",
        maxDate: "2030-01-01",
      },
      { ...common, id: crypto.randomUUID(), type: "boolean" },
      {
        ...common,
        id: crypto.randomUUID(),
        type: "choice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      {
        ...common,
        id: crypto.randomUUID(),
        type: "multiChoice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ],
  };
}
describe("versioned form validation", () => {
  it("validates all field types, required false/zero and optional unanswered controls", () => {
    const form = definition();
    const values = Object.fromEntries(
      form.fields.map((field, i) => [
        field.id,
        ["Answer", 0, "2026-01-01", false, "a", ["a", "b"]][i],
      ]),
    );
    expect(formAnswersSchema(form, true).parse(values)).toEqual(values);
    expect(formAnswersSchema(form, true).safeParse({}).success).toBe(false);
    expect(formAnswersSchema(form, false).safeParse({}).success).toBe(true);
    expect(formAnswersSchema(form, false).safeParse({ [form.fields[1]!.id]: "0" }).success).toBe(
      false,
    );
    expect(
      normalizeFormAnswers(form, {
        [form.fields[3]!.id]: "false",
        [form.fields[1]!.id]: 0,
        [form.fields[0]!.id]: "",
      }),
    ).toEqual({ [form.fields[3]!.id]: false, [form.fields[1]!.id]: 0 });
    expect(
      formAnswersSchema(
        { ...form, fields: form.fields.map((field) => ({ ...field, required: false })) },
        true,
      ).parse({}),
    ).toEqual({});
  });
  it("rejects unknown fields, duplicate choices, invalid dates and numbers outside bounds", () => {
    const form = definition();
    for (const answers of [
      { unknown: "value" },
      { [form.fields[1]!.id]: -1 },
      { [form.fields[2]!.id]: "2026-02-31" },
      { [form.fields[2]!.id]: "2010-01-01" },
      { [form.fields[4]!.id]: "other" },
      { [form.fields[5]!.id]: ["a", "a"] },
    ])
      expect(formAnswersSchema(form, false).safeParse(answers).success).toBe(false);
    expect(
      formDefinitionSchema.safeParse({ ...form, fields: [form.fields[0], form.fields[0]] }).success,
    ).toBe(false);
    const invalid: StudyField = {
      ...form.fields[4]!,
      type: "choice",
      choices: [
        { value: "a", label: "A" },
        { value: "a", label: "B" },
      ],
    };
    expect(formDefinitionSchema.safeParse({ ...form, fields: [invalid] }).success).toBe(false);
  });
  it("enforces full answers only on finalization", () => {
    const payload = {
      kind: "questionnaire",
      writeId: crypto.randomUUID(),
      occurredOn: "2026-01-01",
      notes: "",
      projectClientId: crypto.randomUUID(),
      formVersionClientId: crypto.randomUUID(),
      formClientId: crypto.randomUUID(),
      formVersion: 1,
      definition: definition(),
      answers: {},
      status: "draft",
      amendmentReason: "",
    };
    expect(questionnairePayloadSchema.safeParse(payload).success).toBe(true);
    expect(questionnairePayloadSchema.safeParse({ ...payload, status: "final" }).success).toBe(
      false,
    );
  });
});
it("limits UTF-8 bytes of definitions and answers independently of character counts", () => {
  const common = { label: "Question", help: "", required: false };
  const large = formDefinitionSchema.safeParse({
    title: "Form",
    description: "",
    fields: Array.from({ length: 50 }, () => ({
      ...common,
      id: crypto.randomUUID(),
      type: "choice",
      choices: Array.from({ length: 50 }, (_, i) => ({ value: `c${i}`, label: "я".repeat(200) })),
    })),
  });
  expect(large.success ? [] : large.error.issues.map((issue) => issue.message)).toContain(
    "FORM_TOO_LARGE",
  );
  const definition = {
    title: "Form",
    description: "",
    fields: Array.from({ length: 50 }, () => ({
      ...common,
      id: crypto.randomUUID(),
      type: "text" as const,
      maxLength: 10000,
    })),
  };
  const answers = Object.fromEntries(
    definition.fields.map((field) => [field.id, "я".repeat(4000)]),
  );
  const result = questionnairePayloadSchema.safeParse({
    kind: "questionnaire",
    writeId: crypto.randomUUID(),
    occurredOn: "2026-01-01",
    notes: "",
    projectClientId: crypto.randomUUID(),
    formVersionClientId: crypto.randomUUID(),
    formClientId: crypto.randomUUID(),
    formVersion: 1,
    definition,
    answers,
    status: "draft",
    amendmentReason: "",
  });
  expect(result.success ? [] : result.error.issues.map((issue) => issue.message)).toContain(
    "ANSWERS_TOO_LARGE",
  );
});
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/studyForms.ts": () => import("@/convex/studyForms"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "University",
    kind: "university",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  for (const userId of ["owner", "member", "outsider"])
    await t.mutation(internal.provisioning.approveMembership, {
      userId,
      organizationId,
      role: "researcher",
    });
  const actor = t.withIdentity({ subject: "owner" });
  const projectClientId = crypto.randomUUID();
  await actor.mutation(api.projects.apply, {
    actorId: "owner",
    organizationId,
    clientId: projectClientId,
    expectedRevision: 0,
    idempotencyKey: "project",
    values: {
      title: "Project",
      summary: "",
      topic: "",
      kind: "retrospective",
      status: "draft",
      published: false,
      publicEligibility: "",
      publicContact: "",
    },
  });
  await t.run((ctx) =>
    ctx.db.insert("projectMembers", {
      clientId: crypto.randomUUID(),
      projectClientId,
      userId: "member",
      organizationId,
      role: "member",
      active: true,
      revision: 1,
    }),
  );
  const args = {
    actorId: "owner",
    organizationId,
    projectClientId,
    formClientId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    expectedVersion: 0,
    baseVersionClientId: null,
    definition: definition(),
    status: "published" as const,
    idempotencyKey: "form",
  };
  return { t, actor, organizationId, args };
}
describe("form authorization and immutable versions", () => {
  it("deduplicates versions and rejects stale editors while retaining original definitions", async () => {
    const { t, actor, args } = await setup();
    expect(await actor.mutation(api.studyForms.append, args)).toEqual({ revision: 1 });
    expect(await actor.mutation(api.studyForms.append, args)).toEqual({ revision: 1 });
    await actor.mutation(api.studyForms.append, {
      ...args,
      clientId: crypto.randomUUID(),
      expectedVersion: 1,
      baseVersionClientId: args.clientId,
      definition: { ...args.definition, title: "New title" },
      status: "retired",
      idempotencyKey: "next",
    });
    await expect(
      actor.mutation(api.studyForms.append, {
        ...args,
        clientId: crypto.randomUUID(),
        expectedVersion: 1,
        baseVersionClientId: args.clientId,
        idempotencyKey: "stale",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const rows = await actor.query(api.studyForms.mine, {
      actorId: "owner",
      organizationId: args.organizationId,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.version === 1)?.definition).toEqual(args.definition);
    const audit = await t.run((ctx) => ctx.db.query("researchAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Private|New title/);
    expect(await t.run((ctx) => ctx.db.query("patients").collect())).toEqual([]);
  });
  it("separates template administration from membership and clinical write permissions", async () => {
    const { t, actor, args, organizationId } = await setup();
    await actor.mutation(api.studyForms.append, args);
    const member = t.withIdentity({ subject: "member" });
    expect(
      await member.query(api.studyForms.mine, { actorId: "member", organizationId }),
    ).toHaveLength(1);
    await expect(
      member.mutation(api.studyForms.append, { ...args, actorId: "member" }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(
      await t
        .withIdentity({ subject: "outsider" })
        .query(api.studyForms.mine, { actorId: "outsider", organizationId }),
    ).toEqual([]);
    await expect(t.mutation(api.studyForms.append, args)).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      actor.mutation(api.studyForms.append, { ...args, actorId: "other" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_user", (q) =>
          q.eq("projectClientId", args.projectClientId).eq("userId", "owner"),
        )
        .unique();
      await ctx.db.patch(row!._id, { active: false });
    });
    await expect(actor.mutation(api.studyForms.append, args)).rejects.toThrow("ACCESS_DENIED");
  });
});
