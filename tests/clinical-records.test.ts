import { describe, expect, it, rstest } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
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
describe("normalized clinical records", () => {
  it("supports all record kinds, checks revisions, deduplicates delivery and omits clinical text from audit", async () => {
    const { t, doctor, organizationId, patientClientId } = await setup();
    for (const payload of payloads) {
      const args = {
        actorId: "doctor",
        organizationId,
        patientClientId,
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create" as const,
        payload,
        idempotencyKey: `create.${payload.kind}`,
      };
      await doctor.mutation(api.clinicalRecords.apply, args);
      expect(await doctor.mutation(api.clinicalRecords.apply, args)).toEqual({ revision: 1 });
      await doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        expectedRevision: 1,
        action: "update",
        payload: { ...payload, notes: "Revised private note" },
        idempotencyKey: `update.${payload.kind}`,
      });
      await expect(
        doctor.mutation(api.clinicalRecords.apply, {
          ...args,
          expectedRevision: 1,
          action: "update",
          idempotencyKey: `stale.${payload.kind}`,
        }),
      ).rejects.toThrow("REVISION_CONFLICT");
      const { payload: _payload, ...remove } = args;
      await doctor.mutation(api.clinicalRecords.apply, {
        ...remove,
        action: "delete",
        expectedRevision: 2,
        idempotencyKey: `delete.${payload.kind}`,
      });
    }
    const rows = await doctor.query(api.clinicalRecords.list, {
      actorId: "doctor",
      organizationId,
    });
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.deleted && row.payload === null && row.revision === 3)).toBe(
      true,
    );
    expect(rows[0]).not.toHaveProperty("updatedBy");
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(audit).toHaveLength(15);
    expect(JSON.stringify(audit)).not.toMatch(/Private|Revised|Recorded/);
  });
  it("denies researcher writes, unrelated organizations, mixed-patient IDs and account changes", async () => {
    const { t, doctor, organizationId, patientClientId } = await setup();
    const args = {
      actorId: "doctor",
      organizationId,
      patientClientId,
      clientId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "create" as const,
      payload: payloads[0]!,
      idempotencyKey: "record",
    };
    await expect(t.mutation(api.clinicalRecords.apply, args)).rejects.toThrow("UNAUTHENTICATED");
    const researcher = t.withIdentity({ subject: "researcher" });
    await expect(
      researcher.mutation(api.clinicalRecords.apply, { ...args, actorId: "researcher" }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(
      await researcher.query(api.clinicalRecords.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await expect(
      t
        .withIdentity({ subject: "outsider" })
        .query(api.clinicalRecords.list, { actorId: "outsider", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, { ...args, actorId: "other" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await doctor.mutation(api.clinicalRecords.apply, args);
    expect(
      await researcher.query(api.clinicalRecords.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    const anotherId = crypto.randomUUID();
    await doctor.mutation(api.patients.apply, {
      actorId: "doctor",
      organizationId,
      clientId: anotherId,
      expectedRevision: 0,
      action: "create",
      idempotencyKey: "patient2",
      values: {
        fullName: "Second",
        birthDate: "1990-01-01",
        sex: "unknown",
        diagnosisCodes: [],
        notes: "",
      },
    });
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        patientClientId: anotherId,
        expectedRevision: 1,
        action: "update",
        idempotencyKey: "move",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        expectedRevision: 1,
        action: "update",
        payload: payloads[1]!,
        idempotencyKey: "kind",
      }),
    ).rejects.toThrow("CLINICAL_KIND_IMMUTABLE");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        clientId: crypto.randomUUID(),
        payload: { ...payloads[0]!, notes: "Changed" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });

  it("enforces visit status transitions and terminal schedule on the server", async () => {
    const { doctor, organizationId, patientClientId } = await setup();
    const payload = payloads.find((row) => row.kind === "visit")!;
    const args = {
      actorId: "doctor",
      organizationId,
      patientClientId,
      clientId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "create" as const,
      payload,
      idempotencyKey: "visit",
    };
    await doctor.mutation(api.clinicalRecords.apply, args);
    await doctor.mutation(api.clinicalRecords.apply, {
      ...args,
      action: "update",
      expectedRevision: 1,
      payload: { ...payload, status: "completed", outcome: "Recorded result" },
      idempotencyKey: "finish",
    });
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        action: "update",
        expectedRevision: 2,
        idempotencyKey: "reopen",
      }),
    ).rejects.toThrow("INVALID_VISIT_TRANSITION");
    await expect(
      doctor.mutation(api.clinicalRecords.apply, {
        ...args,
        action: "update",
        expectedRevision: 2,
        payload: {
          ...payload,
          status: "completed",
          outcome: "Recorded result",
          durationMinutes: 60,
        },
        idempotencyKey: "reschedule",
      }),
    ).rejects.toThrow("VISIT_SCHEDULE_IMMUTABLE");
    const result = await doctor.query(api.clinicalRecords.list, {
      actorId: "doctor",
      organizationId,
    });
    expect(result[0]?.revision).toBe(2);
  });
  it("validates calendar dates, medication intervals and observation value types", async () => {
    const { doctor, organizationId, patientClientId } = await setup();
    const base = {
      actorId: "doctor",
      organizationId,
      patientClientId,
      expectedRevision: 0,
      action: "create" as const,
    };
    const invalid: ClinicalPayload[] = [
      { kind: "history", occurredOn: "2020-02-31", notes: "", text: "History" },
      {
        kind: "medication",
        occurredOn: "2020-02-01",
        notes: "",
        drug: "Drug",
        code: "",
        dosage: "Recorded dose",
        route: "",
        endedOn: "2020-01-01",
        status: "completed",
      },
      {
        kind: "observation",
        occurredOn: "2020-01-01",
        notes: "",
        name: "Result",
        code: "",
        numericValue: 1,
        textValue: "Conflicting text",
        unit: "",
      },
      {
        kind: "observation",
        occurredOn: "2020-01-01",
        notes: "",
        name: "Result",
        code: "",
        numericValue: null,
        textValue: "",
        unit: "",
      },
    ];
    for (const payload of invalid)
      await expect(
        doctor.mutation(api.clinicalRecords.apply, {
          ...base,
          clientId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          payload,
        }),
      ).rejects.toThrow("INVALID_CLINICAL_RECORD");
  });
  it("hides deleted patients immediately and clears associated payloads in bounded scheduled batches", async () => {
    rstest.useFakeTimers();
    try {
      const { t, doctor, organizationId, patientClientId } = await setup();
      const original = {
        actorId: "doctor",
        organizationId,
        patientClientId,
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create" as const,
        payload: payloads[0]!,
        idempotencyKey: "original-clinical",
      };
      await doctor.mutation(api.clinicalRecords.apply, original);
      await t.run(async (ctx) => {
        for (let i = 0; i < 124; i++)
          await ctx.db.insert("clinicalRecords", {
            organizationId,
            patientClientId,
            clientId: crypto.randomUUID(),
            payload: payloads[0]!,
            revision: 1,
            deleted: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            updatedBy: "doctor",
          });
      });
      await doctor.mutation(api.patients.apply, {
        actorId: "doctor",
        organizationId,
        clientId: patientClientId,
        expectedRevision: 1,
        action: "delete",
        idempotencyKey: "delete-patient",
      });
      expect(
        await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId }),
      ).toEqual([]);
      await expect(
        doctor.mutation(api.clinicalRecords.apply, {
          actorId: "doctor",
          organizationId,
          patientClientId,
          clientId: crypto.randomUUID(),
          expectedRevision: 0,
          action: "create",
          payload: payloads[0]!,
          idempotencyKey: "after-delete",
        }),
      ).rejects.toThrow("PATIENT_NOT_FOUND");
      await t.finishAllScheduledFunctions(() => {
        rstest.runAllTimers();
      });
      const records = await t.run((ctx) => ctx.db.query("clinicalRecords").collect());
      expect(records).toHaveLength(125);
      expect(
        records.every(
          (record) => record.deleted && record.payload === null && record.revision === 2,
        ),
      ).toBe(true);
      const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
      expect(audit).toHaveLength(126);
      expect(JSON.stringify(audit)).not.toContain("Private medical history");
      await expect(doctor.mutation(api.clinicalRecords.apply, original)).rejects.toThrow(
        "PATIENT_NOT_FOUND",
      );
    } finally {
      rstest.useRealTimers();
    }
  });
});
