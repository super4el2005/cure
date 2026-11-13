import { describe, expect, it } from "@rstest/core";

import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { enrollmentRegister, filterEnrollmentRegister } from "@/src/lib/enrollment-register";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { EnrollmentStatus } from "@/src/lib/study-enrollment-model";

const now = Date.parse("2026-11-14T12:00:00Z");
const project = crypto.randomUUID();
const patient = patientRowSchema.parse({
  clientId: crypto.randomUUID(),
  revision: 1,
  deleted: false,
  fullName: "  Алия   Иванова ",
  birthDate: "1990-01-01",
  sex: "female",
  diagnosisCodes: [],
  notes: "Hidden clinical note",
  updatedAt: 1,
});
function record(status: EnrollmentStatus, expiresOn = "2026-11-20") {
  const event = (value: EnrollmentStatus) => ({
    id: crypto.randomUUID(),
    status: value,
    occurredOn: "2026-11-01",
    reason: `Private ${value} reason`,
    recordedAt: Date.parse("2026-11-01T12:00:00Z"),
    recordedBy: "doctor",
    eligibilityEvidence: value === "enrolled" ? "Private eligibility evidence" : "",
    inclusionConfirmed: value === "enrolled",
    exclusionAbsent: value === "enrolled",
    consent:
      value === "enrolled"
        ? {
            documentReference: "Hidden document reference",
            version: "1",
            signedOn: "2026-11-01",
            expiresOn,
          }
        : null,
  });
  const statuses: EnrollmentStatus[] =
    status === "screening"
      ? [status]
      : ["enrolled", "withdrawn", "completed"].includes(status)
        ? status === "enrolled"
          ? ["screening", "enrolled"]
          : ["screening", "enrolled", status]
        : ["screening", status];
  return clinicalRecordSchema.parse({
    clientId: crypto.randomUUID(),
    patientClientId: patient.clientId,
    revision: statuses.length,
    deleted: false,
    createdAt: 1,
    updatedAt: statuses.length,
    payload: {
      kind: "enrollment",
      writeId: crypto.randomUUID(),
      projectClientId: project,
      protocolClientId: crypto.randomUUID(),
      protocolVersion: 1,
      occurredOn: "2026-11-01",
      notes: "Hidden enrollment note",
      events: statuses.map(event),
    },
  });
}
describe("clinic-only recruitment register", () => {
  it("does not derive patient identities, counts or reasons for researchers even with demographic consent", () => {
    expect(
      enrollmentRegister(
        [
          {
            ...patient,
            consentApproved: true,
            consentScope: ["sex", "diagnoses"],
            accessExpiresAt: now + 1000,
          },
        ],
        [record("enrolled")],
        project,
        "researcher",
        now,
      ),
    ).toEqual([]);
  });
  it("joins only active clinic patients and records for the selected project", () => {
    const valid = record("screening");
    const elsewhere = record("declined");
    if (elsewhere.payload?.kind === "enrollment")
      elsewhere.payload.projectClientId = crypto.randomUUID();
    const missing = { ...record("ineligible"), patientClientId: crypto.randomUUID() };
    const deleted = { ...record("enrolled"), deleted: true, payload: null };
    const visit = clinicalRecordSchema.parse({
      ...record("screening"),
      payload: {
        kind: "history",
        occurredOn: "2026-11-01",
        notes: "Private clinical note",
        text: "Other clinical section",
      },
    });
    const rows = enrollmentRegister(
      [patient],
      [valid, elsewhere, missing, deleted, visit],
      project,
      "doctor",
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: valid.clientId,
      fullName: patient.fullName,
      status: "screening",
      reason: "Private screening reason",
    });
    expect(JSON.stringify(rows)).not.toMatch(/Hidden|eligibility|clinical section|birthDate/);
    expect(
      enrollmentRegister([{ ...patient, deleted: true }], [valid], project, "doctor", now),
    ).toEqual([]);
  });
  it("flags expired consent for current participants, with an inclusive expiration date", () => {
    const expired = record("enrolled", "2026-11-13");
    const today = record("enrolled", "2026-11-14");
    const withdrawn = record("withdrawn", "2026-11-13");
    const rows = enrollmentRegister([patient], [expired, today, withdrawn], project, "doctor", now);
    expect(rows.find((row) => row.clientId === expired.clientId)?.consentExpired).toBe(true);
    expect(rows.find((row) => row.clientId === today.clientId)?.consentExpired).toBe(false);
    expect(rows.find((row) => row.clientId === withdrawn.clientId)?.consentExpired).toBe(false);
    expect(
      filterEnrollmentRegister(
        rows,
        [patient],
        { query: "", statuses: [], expiredOnly: true },
        now,
      ).map((row) => row.clientId),
    ).toEqual([expired.clientId]);
  });
  it("combines name/UUID search, selected states and consent filters without changing source rows", () => {
    const source = [record("declined"), record("enrolled", "2026-11-13"), record("completed")];
    const original = JSON.stringify(source);
    const rows = enrollmentRegister([patient], source, project, "doctor", now);
    expect(
      filterEnrollmentRegister(
        rows,
        [patient],
        { query: "АЛИЯ   ИВАНОВА", statuses: ["enrolled", "declined"], expiredOnly: false },
        now,
      ),
    ).toHaveLength(2);
    expect(
      filterEnrollmentRegister(
        rows,
        [patient],
        { query: patient.clientId, statuses: ["enrolled"], expiredOnly: true },
        now,
      ),
    ).toHaveLength(1);
    expect(
      filterEnrollmentRegister(
        rows,
        [patient],
        { query: "missing", statuses: [], expiredOnly: false },
        now,
      ),
    ).toEqual([]);
    expect(
      filterEnrollmentRegister(
        rows,
        [patient],
        { query: "", statuses: ["completed"], expiredOnly: true },
        now,
      ),
    ).toEqual([]);
    expect(JSON.stringify(source)).toBe(original);
  });
});
