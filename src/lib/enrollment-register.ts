import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { PatientRow } from "@/src/lib/patient-model";
import { defaultPatientSearch, searchPatients } from "@/src/lib/patient-search";
import type { EnrollmentStatus } from "@/src/lib/study-enrollment-model";

// Derive a clinic-only view from the currently authorized local snapshot.
// Project membership alone never authorizes a patient identity or a count.
export function enrollmentRegister(
  patients: readonly PatientRow[],
  records: readonly ClinicalRecord[],
  projectClientId: string,
  role: "doctor" | "researcher",
  now: number,
) {
  if (role !== "doctor") return [];
  const parents = new Map(patients.filter((row) => !row.deleted).map((row) => [row.clientId, row]));
  const today = new Date(now).toISOString().slice(0, 10);
  return records
    .flatMap((record) => {
      const payload = record.payload;
      const patient = parents.get(record.patientClientId);
      if (
        record.deleted ||
        payload?.kind !== "enrollment" ||
        payload.projectClientId !== projectClientId ||
        !patient
      )
        return [];
      const decision = payload.events.at(-1)!;
      const consent = payload.events.findLast((event) => event.status === "enrolled")?.consent;
      return [
        {
          clientId: record.clientId,
          patientClientId: patient.clientId,
          fullName: patient.fullName,
          status: decision.status,
          screenedOn: payload.occurredOn,
          decisionOn: decision.occurredOn,
          reason: decision.reason,
          protocolVersion: payload.protocolVersion,
          consentExpiresOn: consent?.expiresOn ?? null,
          consentExpired:
            decision.status === "enrolled" && Boolean(consent && consent.expiresOn < today),
          updatedAt: record.updatedAt,
        },
      ];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.clientId.localeCompare(b.clientId));
}
export type EnrollmentRegisterRow = ReturnType<typeof enrollmentRegister>[number];
export function filterEnrollmentRegister(
  rows: readonly EnrollmentRegisterRow[],
  patients: readonly PatientRow[],
  filters: { query: string; statuses: readonly EnrollmentStatus[]; expiredOnly: boolean },
  now: number,
) {
  const matching = new Set(
    searchPatients(patients, "doctor", { ...defaultPatientSearch, query: filters.query }, now).map(
      (row) => row.clientId,
    ),
  );
  return rows.filter(
    (row) =>
      matching.has(row.patientClientId) &&
      (!filters.statuses.length || filters.statuses.includes(row.status)) &&
      (!filters.expiredOnly || row.consentExpired),
  );
}
