import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ConsentEvent } from "@/src/lib/consent-model";

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/profiles.ts": () => import("@/convex/profiles"),
  "../convex/organizations.ts": () => import("@/convex/organizations"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
const clientId = "f8ffb8a1-4e31-4bb7-8e33-7f3f564c5258";
const values = {
  fullName: "Test Patient",
  birthDate: "1990-01-01",
  sex: "unknown" as const,
  diagnosisCodes: ["F41"],
  notes: "Private clinical note",
};
function consentEvent(overrides: Partial<ConsentEvent> = {}): ConsentEvent {
  return {
    id: crypto.randomUUID(),
    version: 1,
    kind: "granted",
    purpose: "Research question",
    recipients: ["researcher"],
    scope: ["sex", "diagnoses"],
    expiresAt: Date.now() + 60000,
    recordedAt: Date.now(),
    recordedBy: "doctor",
    documentReference: "Signed consent reference",
    ...overrides,
  };
}
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "Clinic",
    kind: "clinic",
    country: "RU",
    city: "Test",
    description: "",
    published: true,
  });
  for (const [userId, role] of [
    ["doctor", "doctor"],
    ["researcher", "researcher"],
    ["admin", "admin"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { organizationId, userId, role });
  const doctor = t.withIdentity({ subject: "doctor" });
  const researcher = t.withIdentity({ subject: "researcher" });
  const args = {
    actorId: "doctor",
    organizationId,
    clientId,
    idempotencyKey: "create-1",
    expectedRevision: 0,
    action: "create" as const,
    values,
  };
  return { t, organizationId, doctor, researcher, args };
}
describe("patient authorization and transaction guarantees", () => {
  it("denies anonymous and unrelated users", async () => {
    const { t, args } = await setup();
    await expect(t.mutation(api.patients.apply, args)).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      t.withIdentity({ subject: "other" }).mutation(api.patients.apply, args),
    ).rejects.toThrow("ACCESS_DENIED");
  });
  it("supports doctor CRUD, revision checks and audit without patient text", async () => {
    const { t, doctor, args, organizationId } = await setup();
    expect(await doctor.mutation(api.patients.apply, args)).toEqual({ revision: 1 });
    const update = {
      ...args,
      action: "update" as const,
      expectedRevision: 1,
      idempotencyKey: "update-1",
      values: { ...values, fullName: "Updated" },
    };
    expect(await doctor.mutation(api.patients.apply, update)).toEqual({ revision: 2 });
    expect(
      (await doctor.query(api.patients.list, { actorId: "doctor", organizationId }))[0]?.fullName,
    ).toBe("Updated");
    await expect(
      doctor.mutation(api.patients.apply, { ...update, idempotencyKey: "stale" }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await doctor.mutation(api.patients.apply, {
      organizationId,
      actorId: "doctor",
      clientId,
      action: "delete",
      idempotencyKey: "delete-1",
      expectedRevision: 2,
    });
    expect(
      (await doctor.query(api.patients.list, { actorId: "doctor", organizationId }))[0]?.deleted,
    ).toBe(true);
    expect(
      JSON.stringify(await doctor.query(api.patients.list, { actorId: "doctor", organizationId })),
    ).not.toContain(values.notes);
    const audit = await t.run((ctx) => ctx.db.query("patientAudit").collect());
    expect(audit.map((a) => a.action)).toEqual(["create", "update", "delete"]);
    expect(JSON.stringify(audit)).not.toContain(values.fullName);
    expect(JSON.stringify(audit)).not.toContain(values.notes);
  });
  it("deduplicates repeated deliveries atomically and rejects key reuse", async () => {
    const { t, doctor, args } = await setup();
    await doctor.mutation(api.patients.apply, args);
    expect(await doctor.mutation(api.patients.apply, args)).toEqual({ revision: 1 });
    expect(await t.run((ctx) => ctx.db.query("patients").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("patientAudit").collect())).toHaveLength(1);
    await expect(
      doctor.mutation(api.patients.apply, { ...args, values: { ...values, fullName: "Another" } }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("requires current authorization even when replaying a successful receipt", async () => {
    const { t, doctor, args } = await setup();
    await doctor.mutation(api.patients.apply, args);
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", "doctor"))
        .unique();
      await ctx.db.patch(m!._id, { active: false });
    });
    await expect(doctor.mutation(api.patients.apply, args)).rejects.toThrow("ACCESS_DENIED");
  });
  it("researchers only read individually granted structured records and cannot write", async () => {
    const { doctor, researcher, organizationId, args } = await setup();
    await doctor.mutation(api.patients.apply, args);
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await doctor.mutation(api.patients.apply, {
      ...args,
      action: "update",
      expectedRevision: 1,
      idempotencyKey: "consent-1",
      values: { ...values, consentHistory: [consentEvent()] },
    });
    await doctor.mutation(api.patients.share, {
      actorId: "doctor",
      organizationId,
      clientId,
      researcherId: "researcher",
      expiresAt: Date.now() + 60000,
      active: true,
    });
    const rows = await researcher.query(api.patients.list, {
      actorId: "researcher",
      organizationId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diagnosisCodes).toEqual(["F41"]);
    expect(JSON.stringify(rows)).not.toContain(values.fullName);
    expect(JSON.stringify(rows)).not.toContain(values.notes);
    for (const action of ["create", "update", "delete"] as const)
      await expect(researcher.mutation(api.patients.apply, { ...args, action })).rejects.toThrow(
        "ACCESS_DENIED",
      );
    await doctor.mutation(api.patients.share, {
      actorId: "doctor",
      organizationId,
      clientId,
      researcherId: "researcher",
      expiresAt: Date.now() + 60000,
      active: false,
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
  });
  it("rejects an old account's queued operation under another authorized doctor", async () => {
    const { t, organizationId, args } = await setup();
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "another-doctor",
      organizationId,
      role: "doctor",
    });
    await expect(
      t.withIdentity({ subject: "another-doctor" }).mutation(api.patients.apply, args),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(await t.run((ctx) => ctx.db.query("patients").collect())).toHaveLength(0);
  });

  it("does not give an organization administrator patient access", async () => {
    const { t, organizationId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "admin" })
        .query(api.patients.list, { actorId: "doctor", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
  it("rejects invalid calendar dates and unverified memberships", async () => {
    const { t, doctor, args } = await setup();
    await expect(
      doctor.mutation(api.patients.apply, {
        ...args,
        values: { ...values, birthDate: "2025-02-30" },
      }),
    ).rejects.toThrow("INVALID_PATIENT");
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", "doctor"))
        .unique();
      await ctx.db.patch(m!._id, { verified: false });
    });
    await expect(doctor.mutation(api.patients.apply, args)).rejects.toThrow("ACCESS_DENIED");
  });
});
describe("patient consent and researcher access", () => {
  it("requires both a consent and a grant, limits fields and stops access after withdrawal", async () => {
    const { t, doctor, researcher, organizationId, args } = await setup();
    await doctor.mutation(api.patients.apply, { ...args, values: { ...values, sex: "male" } });
    const share = {
      actorId: "doctor",
      organizationId,
      clientId,
      researcherId: "researcher",
      expiresAt: Date.now() + 600000,
      active: true,
    };
    await expect(doctor.mutation(api.patients.share, share)).rejects.toThrow("CONSENT_REQUIRED");
    const granted = consentEvent({ scope: ["diagnoses"] });
    await doctor.mutation(api.patients.apply, {
      ...args,
      action: "update",
      expectedRevision: 1,
      idempotencyKey: "consent-1",
      values: { ...values, sex: "male", consentHistory: [granted] },
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await doctor.mutation(api.patients.share, share);
    const [row] = await researcher.query(api.patients.list, {
      actorId: "researcher",
      organizationId,
    });
    expect(row?.sex).toBe("unknown");
    expect(row?.diagnosisCodes).toEqual(["F41"]);
    expect(row && "consentScope" in row ? row.consentScope : undefined).toEqual(["diagnoses"]);
    expect(row && "accessExpiresAt" in row ? row.accessExpiresAt : undefined).toBe(
      granted.expiresAt,
    );
    expect(JSON.stringify(row)).not.toContain(granted.documentReference);
    const withdrawn = consentEvent({
      ...granted,
      id: crypto.randomUUID(),
      version: 2,
      kind: "withdrawn",
    });
    await doctor.mutation(api.patients.apply, {
      ...args,
      action: "update",
      expectedRevision: 2,
      idempotencyKey: "withdraw-1",
      values: { ...values, consentHistory: [granted, withdrawn] },
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    const renewed = consentEvent({ version: 3 });
    await doctor.mutation(api.patients.apply, {
      ...args,
      action: "update",
      expectedRevision: 3,
      idempotencyKey: "consent-3",
      values: { ...values, consentHistory: [granted, withdrawn, renewed] },
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await doctor.mutation(api.patients.share, share);
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toHaveLength(1);
    const audit = await t.run((ctx) => ctx.db.query("patientAudit").collect());
    expect(audit.filter((a) => a.action.startsWith("consent-")).map((a) => a.action)).toEqual([
      "consent-granted",
      "consent-withdrawn",
      "consent-granted",
    ]);
    expect(JSON.stringify(audit)).not.toContain(granted.documentReference);
  });
  it("rejects changed history, forged authors and unapproved recipients", async () => {
    const { doctor, args } = await setup();
    const event = consentEvent();
    await doctor.mutation(api.patients.apply, {
      ...args,
      values: { ...values, consentHistory: [event] },
    });
    await expect(
      doctor.mutation(api.patients.apply, {
        ...args,
        action: "update",
        expectedRevision: 1,
        idempotencyKey: "tamper",
        values: { ...values, consentHistory: [{ ...event, purpose: "Altered past" }] },
      }),
    ).rejects.toThrow("CONSENT_HISTORY_IMMUTABLE");
    await expect(
      doctor.mutation(api.patients.apply, {
        ...args,
        action: "update",
        expectedRevision: 1,
        idempotencyKey: "erase",
        values: { ...values, consentHistory: [] },
      }),
    ).rejects.toThrow("CONSENT_HISTORY_IMMUTABLE");
    await expect(
      doctor.mutation(api.patients.apply, {
        ...args,
        action: "update",
        expectedRevision: 1,
        idempotencyKey: "forge",
        values: {
          ...values,
          consentHistory: [event, consentEvent({ version: 2, recordedBy: "someone-else" })],
        },
      }),
    ).rejects.toThrow("INVALID_CONSENT");
    await expect(
      doctor.mutation(api.patients.apply, {
        ...args,
        action: "update",
        expectedRevision: 1,
        idempotencyKey: "invalid-recipient",
        values: {
          ...values,
          consentHistory: [event, consentEvent({ version: 2, recipients: ["stranger"] })],
        },
      }),
    ).rejects.toThrow("INVALID_CONSENT_RECIPIENT");
  });
});

describe("professional profiles and public directories", () => {
  it("never self-verifies a role or leaks identity through public profiles", async () => {
    const { t, doctor } = await setup();
    await doctor.mutation(api.profiles.save, {
      actorId: "doctor",
      displayName: "Dr Test",
      profession: "doctor",
      specialty: "Neurology",
      interests: ["Research"],
      languages: ["ru"],
      bio: "",
      published: true,
    });
    expect(await t.query(api.profiles.directory, {})).toEqual([]);
    await t.mutation(internal.provisioning.verifyProfile, { userId: "doctor", verified: true });
    const rows = await t.query(api.profiles.directory, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("userId");
    await expect(
      doctor.mutation(api.profiles.save, {
        actorId: "doctor",
        displayName: "Dr Test",
        profession: "researcher",
        specialty: "",
        interests: [],
        languages: [],
        bio: "",
        published: true,
      }),
    ).rejects.toThrow("VERIFIED_ROLE_CHANGE_REQUIRES_REVIEW");
  });
  it("hides unpublished organizations", async () => {
    const { t } = await setup();
    await t.mutation(internal.provisioning.createOrganization, {
      name: "Private",
      kind: "clinic",
      country: "",
      city: "",
      description: "",
      published: false,
    });
    expect((await t.query(api.organizations.directory, {})).map((o) => o.name)).toEqual(["Clinic"]);
  });
});

it("binds grant changes and recipient snapshots to the expected doctor account", async () => {
  const { doctor, organizationId } = await setup();
  await expect(
    doctor.query(api.patients.researchers, { actorId: "other-doctor", organizationId }),
  ).rejects.toThrow("ACCOUNT_CHANGED");
  await expect(
    doctor.mutation(api.patients.share, {
      actorId: "other-doctor",
      organizationId,
      clientId,
      researcherId: "researcher",
      active: true,
      expiresAt: Date.now() + 60000,
    }),
  ).rejects.toThrow("ACCOUNT_CHANGED");
});

it("rejects a profile form opened under another account", async () => {
  const { doctor } = await setup();
  await expect(
    doctor.mutation(api.profiles.save, {
      actorId: "other",
      displayName: "Other user's draft",
      profession: "doctor",
      specialty: "",
      interests: [],
      languages: [],
      bio: "",
      published: false,
    }),
  ).rejects.toThrow("ACCOUNT_CHANGED");
  expect((await doctor.query(api.profiles.mine, {})).profile).toBeNull();
});
