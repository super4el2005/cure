import { describe, expect, it } from "@rstest/core";

import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";
import {
  defaultPatientSearch,
  patientSearchSchema,
  possiblePatientDuplicates,
  searchPatients,
} from "@/src/lib/patient-search";
function row(values: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private Patient",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: ["F41", "F41.1"],
    notes: "Clinical text",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...values,
  });
}
describe("local patient search", () => {
  it("searches normalized names for doctors and only pseudonymous IDs for researchers", () => {
    const record = row({ fullName: "  PRIVATE   Patient " });
    expect(
      searchPatients([record], "doctor", { ...defaultPatientSearch, query: "private patient" }, 50),
    ).toEqual([record]);
    expect(
      searchPatients([record], "researcher", { ...defaultPatientSearch, query: "private" }, 50),
    ).toEqual([]);
    expect(
      searchPatients(
        [record],
        "researcher",
        { ...defaultPatientSearch, query: record.clientId },
        50,
      ),
    ).toEqual([record]);
    expect(
      searchPatients([record], "doctor", { ...defaultPatientSearch, query: record.notes }, 50),
    ).toEqual([]);
  });
  it("uses exact diagnosis codes, permissions and inclusive birth-date boundaries", () => {
    const record = row();
    expect(
      searchPatients(
        [record],
        "doctor",
        {
          ...defaultPatientSearch,
          diagnoses: ["f41", "F41.1"],
          birthFrom: "1990-01-01",
          birthTo: "1990-01-01",
        },
        50,
      ),
    ).toHaveLength(1);
    expect(
      searchPatients([record], "doctor", { ...defaultPatientSearch, diagnoses: ["F4"] }, 50),
    ).toHaveLength(0);
    expect(
      searchPatients(
        [row({ consentScope: ["sex"] })],
        "researcher",
        { ...defaultPatientSearch, diagnoses: ["F41"] },
        50,
      ),
    ).toHaveLength(0);
    expect(
      searchPatients(
        [record],
        "researcher",
        { ...defaultPatientSearch, birthFrom: "1980-01-01" },
        50,
      ),
    ).toHaveLength(0);
    expect(
      patientSearchSchema.safeParse({
        ...defaultPatientSearch,
        birthFrom: "2000-01-01",
        birthTo: "1990-01-01",
      }).success,
    ).toBe(false);
  });
  it("distinguishes unspecified sex from withheld sex and excludes expired or deleted rows", () => {
    const unknown = row({ sex: "unknown" });
    const withheld = row({ sex: "unknown", consentScope: ["diagnoses"] });
    const source = [unknown, withheld, row({ accessExpiresAt: 50 }), row({ deleted: true })];
    expect(
      searchPatients(source, "researcher", { ...defaultPatientSearch, sex: "unknown" }, 50),
    ).toEqual([unknown]);
    expect(
      searchPatients(source, "researcher", { ...defaultPatientSearch, sex: "unavailable" }, 50),
    ).toEqual([withheld]);
  });
  it("sorts a copied result and does not change the source records", () => {
    const source = [row({ fullName: "Z", updatedAt: 1 }), row({ fullName: "A", updatedAt: 2 })];
    const snapshot = JSON.stringify(source);
    expect(searchPatients(source, "doctor", defaultPatientSearch, 50)[0]).toBe(source[1]);
    expect(searchPatients(source, "doctor", { ...defaultPatientSearch, sort: "name" }, 50)[0]).toBe(
      source[1],
    );
    expect(JSON.stringify(source)).toBe(snapshot);
  });
});
describe("manual duplicate candidates", () => {
  it("requires doctor access, matching normalized name and birth date; excludes deleted and repeated IDs", () => {
    const first = row({ fullName: "  PRIVATE   Patient " });
    const second = row({ fullName: "private patient" });
    const third = row({ birthDate: "1991-01-01" });
    const source = [first, second, first, third, row({ deleted: true }), row({ fullName: "" })];
    expect(possiblePatientDuplicates(source, "doctor")).toHaveLength(1);
    expect(possiblePatientDuplicates(source, "doctor")[0]).toHaveLength(2);
    expect(possiblePatientDuplicates(source, "researcher")).toEqual([]);
  });
});
