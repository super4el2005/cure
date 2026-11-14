import { describe, expect, it, rstest } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { legacyClinicalVersionId } from "@/src/lib/clinical-version-model";
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
const payloads: ClinicalPayload[] = [
  {
    kind: "history",
    occurredOn: "2020-01-01",
    notes: "Private note",
    text: "Private medical history",
  },
  {
    kind: "allergy",
    occurredOn: "2020-01-01",
    notes: "Private note",
    substance: "Recorded substance",
    reaction: "Recorded reaction",
    severity: "unknown",
    status: "active",
  },
  {
    kind: "medication",
    occurredOn: "2020-01-01",
    notes: "Private note",
    drug: "Recorded drug",
    code: "",
    dosage: "Recorded dosage",
    route: "Recorded route",
    endedOn: "",
    status: "active",
  },
  {
    kind: "observation",
    occurredOn: "2020-01-01",
    notes: "Private note",
    name: "Recorded lab result",
    code: "",
    numericValue: 12.5,
    textValue: "",
    unit: "recorded unit",
  },
  {
    kind: "visit",
    occurredOn: "2026-11-01",
    notes: "Private note",
    scheduledFor: "2026-11-01T01:30:00-04:00[America/New_York]",
    durationMinutes: 30,
    visitType: "consultation",
    status: "planned",
    reason: "Private visit reason",
    location: "",
    outcome: "",
    followUpOn: "",
    cancellationReason: "",
  },
];
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
  const patientClientId = crypto.randomUUID();
  const patient = {
    actorId: "doctor",
    organizationId,
    clientId: patientClientId,
    action: "create" as const,
    expectedRevision: 0,
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
  return { t, doctor, organizationId, patientClientId, patient };
}

describe("clinical content history and predecessor checks", () => {
  it.each(payloads)(
    "preserves complete $kind revisions atomically and deduplicates delivery",
    async (payload) => {
      const { t, doctor, organizationId, patientClientId } = await setup();
      const first = {
        actorId: "doctor",
        organizationId,
        patientClientId,
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create" as const,
        payload,
        historyId: crypto.randomUUID(),
        expectedHistoryId: null,
        idempotencyKey: "first",
      };
      await doctor.mutation(api.clinicalRecords.apply, first);
      expect(await doctor.mutation(api.clinicalRecords.apply, first)).toEqual({ revision: 1 });
      const next = {
        ...first,
        expectedRevision: 1,
        action: "update" as const,
        payload: { ...payload, notes: "Amended private content" },
        historyId: crypto.randomUUID(),
        expectedHistoryId: first.historyId,
        idempotencyKey: "next",
      };
      await doctor.mutation(api.clinicalRecords.apply, next);
      expect(await doctor.mutation(api.clinicalRecords.apply, next)).toEqual({ revision: 2 });
      const versions = await doctor.query(api.clinicalRecords.versions, {
        actorId: "doctor",
        organizationId,
      });
      expect(versions).toHaveLength(2);
      expect(versions.find((row) => row.clientId === first.historyId)).toMatchObject({
        recordClientId: first.clientId,
        patientClientId,
        revision: 1,
        payload,
        recordedBy: "doctor",
        confirmed: true,
      });
      expect(versions.find((row) => row.clientId === next.historyId)).toMatchObject({
        revision: 2,
        payload: next.payload,
        recordedBy: "doctor",
      });
      expect(
        await t
          .withIdentity({ subject: "researcher" })
          .query(api.clinicalRecords.versions, { actorId: "researcher", organizationId }),
      ).toEqual([]);
      await expect(
        t
          .withIdentity({ subject: "admin" })
          .query(api.clinicalRecords.versions, { actorId: "admin", organizationId }),
      ).rejects.toThrow("ACCESS_DENIED");
      await expect(
        doctor.query(api.clinicalRecords.versions, { actorId: "researcher", organizationId }),
      ).rejects.toThrow("ACCOUNT_CHANGED");
      await expect(
        doctor.mutation(api.clinicalRecords.apply, {
          ...next,
          expectedRevision: 2,
          expectedHistoryId: first.historyId,
          historyId: crypto.randomUUID(),
          idempotencyKey: "stale-predecessor",
        }),
      ).rejects.toThrow("REVISION_CONFLICT");
      await expect(
        doctor.mutation(api.clinicalRecords.apply, {
          ...next,
          expectedRevision: 2,
          expectedHistoryId: next.historyId,
          historyId: first.historyId,
          idempotencyKey: "reused-snapshot",
        }),
      ).rejects.toThrow("INVALID_CLINICAL_RECORD");
      expect(
        await doctor.query(api.clinicalRecords.versions, { actorId: "doctor", organizationId }),
      ).toHaveLength(2);
      const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
      expect(JSON.stringify(audit)).not.toContain("Private");
      expect(JSON.stringify(audit)).not.toContain("Amended");
    },
  );
  it("preserves the current legacy baseline without fabricating already lost history and retains legacy receipt fingerprints", async () => {
    const { t, doctor, organizationId, patientClientId } = await setup();
    const clientId = crypto.randomUUID();
    const payload = payloads[0]!;
    if (payload.kind !== "history") throw new Error("test setup");
    await t.run((ctx) =>
      ctx.db.insert("clinicalRecords", {
        organizationId,
        clientId,
        patientClientId,
        revision: 7,
        payload,
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
        updatedBy: "original-doctor",
      }),
    );
    const args = {
      actorId: "doctor",
      organizationId,
      clientId,
      patientClientId,
      expectedRevision: 7,
      action: "update" as const,
      payload: { ...payload, notes: "New baseline change" },
      idempotencyKey: "legacy-compatible",
    };
    await doctor.mutation(api.clinicalRecords.apply, args);
    expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 8 });
    const versions = await doctor.query(api.clinicalRecords.versions, {
      actorId: "doctor",
      organizationId,
    });
    expect(versions).toHaveLength(2);
    expect(
      versions.find((row) => row.clientId === legacyClinicalVersionId(clientId, 7)),
    ).toMatchObject({ revision: 7, payload, recordedBy: "original-doctor", recordedAt: 2 });
    expect(versions.map((row) => row.revision)).toEqual([7, 8]);
    const oldPayload = {
      domain: "clinical.record.v1",
      organizationId,
      patientClientId,
      clientId,
      expectedRevision: 7,
      action: "update",
      payload: {
        occurredOn: args.payload.occurredOn,
        notes: args.payload.notes,
        kind: "history",
        text: args.payload.text,
      },
    };
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(oldPayload)),
    );
    const fingerprint = Array.from(new Uint8Array(bytes), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const receipt = await t.run((ctx) =>
      ctx.db
        .query("workspaceReceipts")
        .withIndex("by_owner_key", (q) =>
          q.eq("userId", "doctor").eq("idempotencyKey", "legacy-compatible"),
        )
        .unique(),
    );
    expect(receipt?.fingerprint).toBe(fingerprint);
  });
  it.each(["record", "patient"] as const)(
    "closes %s history before bounded content erasure and rejects cross-clinic reads",
    async (target) => {
      rstest.useFakeTimers();
      try {
        const { t, doctor, organizationId, patientClientId, patient } = await setup();
        const clientId = crypto.randomUUID();
        let historyId: string | null = null;
        for (let revision = 0; revision < 55; revision++) {
          const nextId = crypto.randomUUID();
          await doctor.mutation(api.clinicalRecords.apply, {
            actorId: "doctor",
            organizationId,
            patientClientId,
            clientId,
            expectedRevision: revision,
            action: revision ? "update" : "create",
            payload: { ...payloads[0]!, notes: `Private revision ${revision}` },
            historyId: nextId,
            expectedHistoryId: historyId,
            idempotencyKey: `history-${revision}`,
          });
          historyId = nextId;
        }
        expect(
          await doctor.query(api.clinicalRecords.versions, { actorId: "doctor", organizationId }),
        ).toHaveLength(55);
        if (target === "patient")
          await doctor.mutation(api.patients.apply, {
            ...patient,
            action: "delete",
            expectedRevision: 1,
            idempotencyKey: "delete-patient",
          });
        else
          await doctor.mutation(api.clinicalRecords.apply, {
            actorId: "doctor",
            organizationId,
            patientClientId,
            clientId,
            action: "delete",
            expectedRevision: 55,
            historyId: crypto.randomUUID(),
            expectedHistoryId: historyId,
            idempotencyKey: "delete-record",
          });
        expect(
          await doctor.query(api.clinicalRecords.versions, { actorId: "doctor", organizationId }),
        ).toEqual([]);
        await t.finishAllScheduledFunctions(() => rstest.runAllTimers());
        expect(await t.run((ctx) => ctx.db.query("clinicalVersions").collect())).toEqual([]);
        await expect(
          t
            .withIdentity({ subject: "outsider" })
            .query(api.clinicalRecords.versions, { actorId: "outsider", organizationId }),
        ).rejects.toThrow("ACCESS_DENIED");
      } finally {
        rstest.useRealTimers();
      }
    },
  );
});
