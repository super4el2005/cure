import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { addDays, scheduledVisits, visitScheduleItemSchema } from "@/src/lib/protocol-schedule";
import type { VisitScheduleItem } from "@/src/lib/protocol-schedule";
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import type { StudyVisitPayload } from "@/src/lib/study-visit-model";

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const item = (overrides: Partial<VisitScheduleItem> = {}): VisitScheduleItem => ({
  title: "Visit",
  offsetDays: 0,
  windowBeforeDays: 0,
  windowAfterDays: 0,
  visitType: "consultation",
  durationMinutes: 30,
  ...overrides,
});
describe("protocol visit schedule model", () => {
  it("adds days across month and leap-year boundaries in UTC", () => {
    expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2026-11-15", -4)).toBe("2026-11-11");
    expect(addDays("2026-11-15", 0)).toBe("2026-11-15");
  });
  it("derives placeholder time and inclusive windows from the enrollment date", () => {
    const [visit] = scheduledVisits(
      [item({ offsetDays: 7, windowBeforeDays: 2, windowAfterDays: 3 })],
      "2026-11-01",
      { signedOn: "2026-11-01", expiresOn: "2027-11-01" },
    );
    expect(visit).toEqual({
      item: item({ offsetDays: 7, windowBeforeDays: 2, windowAfterDays: 3 }),
      scheduledDate: "2026-11-08",
      scheduledFor: "2026-11-08T12:00:00+00:00[UTC]",
      windowFrom: "2026-11-06",
      windowTo: "2026-11-11",
    });
  });
  it("keeps only visits inside the documented consent validity, inclusive", () => {
    const rows = scheduledVisits(
      [
        item({ title: "A", offsetDays: 0 }),
        item({ title: "B", offsetDays: 30 }),
        item({ title: "C", offsetDays: 31 }),
      ],
      "2026-11-01",
      { signedOn: "2026-11-01", expiresOn: "2026-12-01" },
    );
    expect(rows.map((row) => row.item.title)).toEqual(["A", "B"]);
    expect(
      scheduledVisits([item({ offsetDays: 0 })], "2026-11-01", {
        signedOn: "2026-11-02",
        expiresOn: "2026-12-01",
      }),
    ).toEqual([]);
  });
  it("rejects empty titles, negative offsets and unbounded windows", () => {
    expect(visitScheduleItemSchema.safeParse(item({ title: "" })).success).toBe(false);
    expect(visitScheduleItemSchema.safeParse(item({ offsetDays: -1 })).success).toBe(false);
    expect(visitScheduleItemSchema.safeParse(item({ offsetDays: 3651 })).success).toBe(false);
    expect(visitScheduleItemSchema.safeParse(item({ windowAfterDays: 91 })).success).toBe(false);
    expect(visitScheduleItemSchema.safeParse(item({ durationMinutes: 0 })).success).toBe(false);
  });
});

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/patients.ts": () => import("@/convex/patients"),
  "../convex/clinicalRecords.ts": () => import("@/convex/clinicalRecords"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/protocols.ts": () => import("@/convex/protocols"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
function enrollmentEvent(status: EnrollmentStatus, actorId: string, expiresOn: string) {
  const occurredOn = today();
  return {
    id: crypto.randomUUID(),
    status,
    occurredOn,
    reason: `Private ${status} reason`,
    recordedBy: actorId,
    recordedAt: Date.now(),
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
describe("automatic visit scheduling on enrollment", () => {
  it("generates planned visits from the protocol schedule inside consent validity, once", async () => {
    const t = convexTest(schema, modules);
    const organizationId = await t.mutation(internal.provisioning.createOrganization, {
      name: "Clinic",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    await t.mutation(internal.provisioning.approveMembership, {
      userId: "doctor",
      organizationId,
      role: "doctor",
    });
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
    await doctor.mutation(api.protocols.append, {
      actorId: "doctor",
      projectClientId,
      clientId: protocolClientId,
      expectedVersion: 0,
      idempotencyKey: "protocol",
      values: {
        hypothesis: "Question",
        inclusion: "Eligible",
        exclusion: "Exclusions",
        endpoints: "Outcome",
        analysisPlan: "Plan",
        ethicsApproved: true,
        ethicsReference: "Approval",
        ethicsExpiresAt: Date.now() + 86400000,
        visitSchedule: [
          item({ title: "Baseline", offsetDays: 0 }),
          item({
            title: "Week 1",
            offsetDays: 7,
            windowBeforeDays: 2,
            windowAfterDays: 2,
            visitType: "followUp",
            durationMinutes: 45,
          }),
          item({ title: "Month 3", offsetDays: 90 }),
        ],
      },
    });
    await t.run(async (ctx) => {
      const project = (await ctx.db.query("projects").collect())[0]!;
      await ctx.db.patch(project._id, { status: "recruiting" });
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
    const recordClientId = crypto.randomUUID();
    const consentExpiresOn = plusDays(30);
    let current: EnrollmentPayload = {
      kind: "enrollment",
      writeId: crypto.randomUUID(),
      projectClientId,
      protocolClientId,
      protocolVersion: 1,
      occurredOn: today(),
      notes: "",
      events: [enrollmentEvent("screening", "doctor", consentExpiresOn)],
    };
    await doctor.mutation(api.clinicalRecords.apply, {
      actorId: "doctor",
      organizationId,
      clientId: recordClientId,
      patientClientId,
      action: "create",
      expectedRevision: 0,
      expectedWriteId: null,
      payload: current,
      idempotencyKey: "screening",
    });
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })).filter(
        (row) => row.payload?.kind === "studyVisit",
      ),
    ).toHaveLength(0);
    current = {
      ...current,
      writeId: crypto.randomUUID(),
      events: [...current.events, enrollmentEvent("enrolled", "doctor", consentExpiresOn)],
    };
    const screeningWriteId = (
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })
    ).find((row) => row.clientId === recordClientId)!;
    const enrolled = {
      actorId: "doctor",
      organizationId,
      clientId: recordClientId,
      patientClientId,
      action: "update" as const,
      expectedRevision: 1,
      expectedWriteId:
        screeningWriteId.payload?.kind === "enrollment" ? screeningWriteId.payload.writeId : null,
      payload: current,
      idempotencyKey: "enrolled",
    };
    await doctor.mutation(api.clinicalRecords.apply, enrolled);
    const visits = (
      await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })
    )
      .filter((row) => row.payload?.kind === "studyVisit")
      .map((row) => row.payload as StudyVisitPayload)
      .sort((a, b) => a.reason.localeCompare(b.reason));
    expect(visits.map((row) => row.reason)).toEqual(["Baseline", "Week 1"]);
    expect(visits[0]).toMatchObject({
      status: "planned",
      visitType: "consultation",
      durationMinutes: 30,
      enrollmentClientId: recordClientId,
      enrollmentWriteId: current.writeId,
      projectClientId,
      protocolClientId,
      protocolVersion: 1,
      windowFrom: today(),
      windowTo: today(),
      scheduledFor: `${today()}T12:00:00+00:00[UTC]`,
    });
    expect(visits[1]).toMatchObject({
      status: "planned",
      visitType: "followUp",
      durationMinutes: 45,
      windowFrom: addDays(today(), 5),
      windowTo: addDays(today(), 9),
      scheduledFor: `${addDays(today(), 7)}T12:00:00+00:00[UTC]`,
    });
    // Replaying the enrollment mutation must not duplicate the schedule.
    await doctor.mutation(api.clinicalRecords.apply, enrolled);
    expect(
      (await doctor.query(api.clinicalRecords.list, { actorId: "doctor", organizationId })).filter(
        (row) => row.payload?.kind === "studyVisit",
      ),
    ).toHaveLength(2);
    const versions = await t.run((ctx) => ctx.db.query("clinicalVersions").collect());
    const audit = await t.run((ctx) => ctx.db.query("clinicalAudit").collect());
    expect(versions.filter((row) => row.payload.kind === "studyVisit")).toHaveLength(2);
    expect(
      audit.filter((row) => row.action === "create" && row.patientClientId === patientClientId),
    ).toHaveLength(3);
  });
});
