import { describe, expect, it, rstest } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ConsentEvent } from "@/src/lib/consent-model";
import { legacyPatientVersionId } from "@/src/lib/patient-version-model";

const modules = {
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
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

describe("patient card revision history", () => {
  it("preserves identity, diagnosis and consent content without granting access through past consent", async () => {
    const { t, doctor, researcher, args, organizationId } = await setup();
    const first = { ...args, historyId: crypto.randomUUID(), expectedHistoryId: null };
    await doctor.mutation(api.patients.apply, first);
    expect(await doctor.mutation(api.patients.apply, first)).toEqual({ revision: 1 });
    const granted = consentEvent();
    const next = {
      ...first,
      action: "update" as const,
      expectedRevision: 1,
      expectedHistoryId: first.historyId,
      historyId: crypto.randomUUID(),
      idempotencyKey: "grant",
      values: {
        ...values,
        fullName: "Changed identity",
        notes: "Changed private note",
        consentHistory: [granted],
      },
    };
    await doctor.mutation(api.patients.apply, next);
    await doctor.mutation(api.patients.share, {
      actorId: "doctor",
      organizationId,
      clientId,
      researcherId: "researcher",
      expiresAt: Date.now() + 30000,
      active: true,
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toHaveLength(1);
    expect(
      await researcher.query(api.patients.versions, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    const withdrawn = consentEvent({ version: 2, kind: "withdrawn", expiresAt: granted.expiresAt });
    const final = {
      ...next,
      expectedRevision: 2,
      expectedHistoryId: next.historyId,
      historyId: crypto.randomUUID(),
      idempotencyKey: "withdraw",
      values: { ...next.values, consentHistory: [granted, withdrawn] },
    };
    await doctor.mutation(api.patients.apply, final);
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    expect(
      await researcher.query(api.patients.versions, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    const history = await doctor.query(api.patients.versions, {
      actorId: "doctor",
      organizationId,
    });
    expect(history).toHaveLength(3);
    expect(history.find((row) => row.clientId === first.historyId)).toMatchObject({
      patientClientId: clientId,
      revision: 1,
      values: { ...values, consentHistory: [] },
      recordedBy: "doctor",
      confirmed: true,
    });
    expect(history.find((row) => row.clientId === next.historyId)).toMatchObject({
      revision: 2,
      values: next.values,
    });
    expect(history.find((row) => row.clientId === final.historyId)).toMatchObject({
      revision: 3,
      values: final.values,
    });
    await expect(
      t
        .withIdentity({ subject: "admin" })
        .query(api.patients.versions, { actorId: "admin", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      doctor.query(api.patients.versions, { actorId: "other", organizationId }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      t
        .withIdentity({ subject: "outside-clinic" })
        .query(api.patients.versions, { actorId: "outside-clinic", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(
      JSON.stringify(await t.run((ctx) => ctx.db.query("patientAudit").collect())),
    ).not.toMatch(/Test Patient|Changed|Signed consent/);
  });
  it("checks the actual predecessor and unique revision identity, including rejected writes", async () => {
    const { doctor, args, organizationId } = await setup();
    const first = { ...args, historyId: crypto.randomUUID(), expectedHistoryId: null };
    await doctor.mutation(api.patients.apply, first);
    const second = {
      ...first,
      action: "update" as const,
      expectedRevision: 1,
      expectedHistoryId: first.historyId,
      historyId: crypto.randomUUID(),
      idempotencyKey: "second",
      values: { ...values, notes: "Second" },
    };
    await doctor.mutation(api.patients.apply, second);
    await expect(
      doctor.mutation(api.patients.apply, {
        ...second,
        expectedRevision: 2,
        expectedHistoryId: first.historyId,
        historyId: crypto.randomUUID(),
        idempotencyKey: "wrong-predecessor",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      doctor.mutation(api.patients.apply, {
        ...second,
        expectedRevision: 2,
        expectedHistoryId: second.historyId,
        historyId: first.historyId,
        idempotencyKey: "reused-archive",
      }),
    ).rejects.toThrow("INVALID_PATIENT");
    await expect(
      doctor.mutation(api.patients.apply, {
        ...second,
        expectedRevision: 2,
        expectedHistoryId: second.historyId,
        historyId: crypto.randomUUID(),
        idempotencyKey: "invalid-consent",
        values: { ...values, consentHistory: [consentEvent({ recipients: ["not-a-researcher"] })] },
      }),
    ).rejects.toThrow("INVALID_CONSENT_RECIPIENT");
    expect(
      await doctor.query(api.patients.versions, { actorId: "doctor", organizationId }),
    ).toHaveLength(2);
  });
  it("seeds only the available legacy baseline and keeps the old receipt fingerprint", async () => {
    const { t, doctor, args, organizationId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("patients", {
        ...values,
        clientId,
        organizationId,
        revision: 9,
        deleted: false,
        updatedAt: 2,
        updatedBy: "original-author",
      }),
    );
    const update = {
      ...args,
      action: "update" as const,
      expectedRevision: 9,
      idempotencyKey: "legacy",
      values: { ...values, notes: "Legacy correction" },
    };
    await doctor.mutation(api.patients.apply, update);
    expect(await doctor.mutation(api.patients.apply, update)).toEqual({ revision: 10 });
    const history = await doctor.query(api.patients.versions, {
      actorId: "doctor",
      organizationId,
    });
    expect(history.map((row) => row.revision)).toEqual([9, 10]);
    expect(
      history.find((row) => row.clientId === legacyPatientVersionId(clientId, 9)),
    ).toMatchObject({ values, recordedAt: 2, recordedBy: "original-author" });
    const body = {
      actorId: "doctor",
      organizationId,
      clientId,
      expectedRevision: 9,
      action: "update",
      values: {
        fullName: values.fullName,
        birthDate: values.birthDate,
        sex: values.sex,
        diagnosisCodes: values.diagnosisCodes,
        notes: "Legacy correction",
      },
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(body)),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const receipt = await t.run((ctx) =>
      ctx.db
        .query("operationReceipts")
        .withIndex("by_owner_key", (q) => q.eq("userId", "doctor").eq("idempotencyKey", "legacy"))
        .unique(),
    );
    expect(receipt?.fingerprint).toBe(fingerprint);
  });
  it("closes deleted cards immediately and cleans 55 card versions plus orphaned clinical history in bounded batches", async () => {
    rstest.useFakeTimers();
    try {
      const { t, doctor, args, organizationId } = await setup();
      let previous: string | null = null;
      for (let revision = 0; revision < 55; revision++) {
        const historyId = crypto.randomUUID();
        await doctor.mutation(api.patients.apply, {
          ...args,
          action: revision ? "update" : "create",
          expectedRevision: revision,
          historyId,
          expectedHistoryId: previous,
          idempotencyKey: `version-${revision}`,
          values: { ...values, notes: `Private version ${revision}` },
        });
        previous = historyId;
      }
      expect(
        await doctor.query(api.patients.versions, { actorId: "doctor", organizationId }),
      ).toHaveLength(55);
      await t.run((ctx) =>
        ctx.db.insert("clinicalVersions", {
          organizationId,
          clientId: crypto.randomUUID(),
          patientClientId: clientId,
          recordClientId: crypto.randomUUID(),
          revision: 1,
          payload: {
            kind: "history",
            occurredOn: "2020-01-01",
            notes: "Private orphan",
            text: "Private orphan content",
          },
          recordedAt: 1,
          recordedBy: "doctor",
        }),
      );
      const deletion = {
        ...args,
        action: "delete" as const,
        expectedRevision: 55,
        historyId: crypto.randomUUID(),
        expectedHistoryId: previous,
        idempotencyKey: "delete",
      };
      await doctor.mutation(api.patients.apply, deletion);
      expect(await doctor.mutation(api.patients.apply, deletion)).toEqual({ revision: 56 });
      expect(
        await doctor.query(api.patients.versions, { actorId: "doctor", organizationId }),
      ).toEqual([]);
      await t.finishAllScheduledFunctions(() => rstest.runAllTimers());
      expect(await t.run((ctx) => ctx.db.query("patientVersions").collect())).toEqual([]);
      expect(await t.run((ctx) => ctx.db.query("clinicalVersions").collect())).toEqual([]);
    } finally {
      rstest.useRealTimers();
    }
  });
});
