import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import schema from "@/convex/schema";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import type { FormDefinition } from "@/src/lib/study-form-model";

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/registries.ts": () => import("@/convex/registries"),
};
function definition(): FormDefinition {
  const common = { label: "Question", help: "", required: true };
  const fields: FormDefinition["fields"] = [
    { ...common, id: crypto.randomUUID(), type: "number", minimum: 0, maximum: 300, unit: "мм" },
    { ...common, id: crypto.randomUUID(), type: "text", maxLength: 100 },
  ];
  return {
    title: "Registry form",
    description: "",
    fields,
    registry: { code: "REG-1", indicators: [fields[0]!.id] },
  };
}
function enrollmentEvent(
  status: "screening" | "enrolled" | "withdrawn" | "completed",
  occurredOn: string,
  expiresOn: string,
) {
  return {
    id: crypto.randomUUID(),
    status,
    occurredOn,
    reason: "Private reason",
    recordedBy: "doctor",
    recordedAt: Date.parse(`${occurredOn}T12:00:00Z`),
    eligibilityEvidence: status === "enrolled" ? "Private evidence" : "",
    inclusionConfirmed: status === "enrolled",
    exclusionAbsent: status === "enrolled",
    consent:
      status === "enrolled"
        ? {
            documentReference: "Private document",
            version: "1",
            signedOn: occurredOn,
            expiresOn,
          }
        : null,
  };
}
function recordRows(
  organizationId: Id<"organizations">,
  patientClientId: string,
  payload: ClinicalPayload,
) {
  return {
    organizationId,
    clientId: crypto.randomUUID(),
    patientClientId,
    payload,
    revision: 1,
    deleted: false,
    createdAt: 1000,
    updatedAt: 1000,
    updatedBy: "doctor-private-id",
  };
}
async function setup() {
  const t = convexTest(schema, modules);
  const clinic = await t.mutation(internal.provisioning.createOrganization, {
    name: "Clinic",
    kind: "clinic",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  const outside = await t.mutation(internal.provisioning.createOrganization, {
    name: "Outside",
    kind: "university",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  for (const [userId, organizationId, role] of [
    ["researcher", clinic, "researcher"],
    ["outsider", outside, "researcher"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, organizationId, role });
  const projectClientId = crypto.randomUUID();
  const formClientId = crypto.randomUUID();
  const form = definition();
  const patientA = crypto.randomUUID();
  const patientB = crypto.randomUUID();
  const patientC = crypto.randomUUID();
  await t.run(async (ctx) => {
    await ctx.db.insert("projects", {
      clientId: projectClientId,
      organizationId: clinic,
      title: "Study",
      summary: "",
      topic: "",
      kind: "prospective",
      status: "recruiting",
      published: false,
      publicEligibility: "",
      publicContact: "",
      revision: 1,
      createdAt: 1000,
      updatedAt: 1000,
      createdBy: "researcher",
      updatedBy: "researcher",
    });
    await ctx.db.insert("projectMembers", {
      clientId: crypto.randomUUID(),
      projectClientId,
      userId: "researcher",
      organizationId: clinic,
      role: "viewer",
      active: true,
      revision: 1,
    });
    await ctx.db.insert("projectMembers", {
      clientId: crypto.randomUUID(),
      projectClientId,
      userId: "outsider",
      organizationId: outside,
      role: "viewer",
      active: true,
      revision: 1,
    });
    await ctx.db.insert("studyForms", {
      clientId: crypto.randomUUID(),
      formClientId,
      projectClientId,
      version: 1,
      baseVersionClientId: null,
      definition: form,
      status: "published",
      createdAt: 1000,
      createdBy: "researcher",
    });
    const questionnaire = (patientClientId: string, occurredOn: string, draft = false) =>
      recordRows(clinic, patientClientId, {
        kind: "questionnaire",
        writeId: crypto.randomUUID(),
        occurredOn,
        notes: "Private notes",
        projectClientId,
        formVersionClientId: crypto.randomUUID(),
        formClientId,
        formVersion: 1,
        definition: form,
        answers: {
          [form.fields[0]!.id]: 120,
          [form.fields[1]!.id]: "Private free text answer",
        },
        status: draft ? "draft" : "final",
        amendmentReason: "",
      });
    const enrollment = (
      patientClientId: string,
      events: Extract<ClinicalPayload, { kind: "enrollment" }>["events"],
    ) =>
      recordRows(clinic, patientClientId, {
        kind: "enrollment",
        writeId: crypto.randomUUID(),
        occurredOn: "2026-01-01",
        notes: "Private enrollment note",
        projectClientId,
        protocolClientId: crypto.randomUUID(),
        protocolVersion: 1,
        events,
      });
    await ctx.db.insert(
      "clinicalRecords",
      enrollment(patientA, [
        enrollmentEvent("screening", "2026-01-01", ""),
        enrollmentEvent("enrolled", "2026-01-02", "2099-01-01"),
      ]),
    );
    await ctx.db.insert(
      "clinicalRecords",
      enrollment(patientB, [
        enrollmentEvent("enrolled", "2026-01-02", "2099-01-01"),
        enrollmentEvent("withdrawn", "2026-02-01", ""),
      ]),
    );
    await ctx.db.insert(
      "clinicalRecords",
      enrollment(patientC, [enrollmentEvent("enrolled", "2026-01-02", "2020-01-01")]),
    );
    for (const row of [
      questionnaire(patientA, "2026-02-01"),
      questionnaire(patientA, "2026-03-01"),
      questionnaire(patientA, "2026-03-02", true),
      questionnaire(patientB, "2026-02-01"),
      questionnaire(patientC, "2026-02-01"),
    ])
      await ctx.db.insert("clinicalRecords", row);
  });
  return { t, clinic, outside, projectClientId, formClientId, form, patientA };
}
describe("de-identified registry observations query", () => {
  it("returns only rows of participants with an active study consent", async () => {
    const { t, clinic, formClientId, form, patientA, projectClientId } = await setup();
    const researcher = t.withIdentity({ subject: "researcher" });
    const result = await researcher.query(api.registries.observations, {
      actorId: "researcher",
      organizationId: clinic,
      formClientId,
    });
    expect(result.projectClientId).toBe(projectClientId);
    expect(result.registry.code).toBe("REG-1");
    expect(result.fields.map((field) => field.id)).toEqual([form.fields[0]!.id]);
    expect(result.rows).toHaveLength(2);
    expect([...new Set(result.rows.map((row) => row.participantCode))]).toHaveLength(1);
    expect(result.rows.map((row) => row.occurredOn)).toEqual(["2026-02-01", "2026-03-01"]);
    for (const row of result.rows) {
      expect(Object.keys(row.answers)).toEqual([form.fields[0]!.id]);
      expect(row.answers[form.fields[0]!.id]).toBe(120);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(patientA);
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("doctor-private-id");
  });
  it("denies access without organization membership and rejects actor mismatch", async () => {
    const { t, clinic, outside, formClientId } = await setup();
    const outsider = t.withIdentity({ subject: "outsider" });
    await expect(
      outsider.query(api.registries.observations, {
        actorId: "outsider",
        organizationId: clinic,
        formClientId,
      }),
    ).rejects.toThrow();
    const outsiderResult = await outsider.query(api.registries.observations, {
      actorId: "outsider",
      organizationId: outside,
      formClientId,
    });
    expect(outsiderResult.rows).toEqual([]);
    const researcher = t.withIdentity({ subject: "researcher" });
    await expect(
      researcher.query(api.registries.observations, {
        actorId: "someone-else",
        organizationId: clinic,
        formClientId,
      }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      researcher.query(api.registries.observations, {
        actorId: "researcher",
        organizationId: clinic,
        formClientId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("REGISTRY_NOT_FOUND");
  });
});
