import { z } from "zod";

import type { PatientRow } from "@/src/lib/patient-model";

export const patientSearchSchema = z
  .object({
    query: z.string().max(200),
    diagnoses: z.array(z.string().trim().min(1).max(50)).max(100),
    sex: z.enum(["any", "female", "male", "unknown", "unavailable"]),
    birthFrom: z.union([z.literal(""), z.iso.date()]),
    birthTo: z.union([z.literal(""), z.iso.date()]),
    sort: z.enum(["recent", "name", "id"]),
  })
  .refine((value) => !value.birthFrom || !value.birthTo || value.birthFrom <= value.birthTo, {
    path: ["birthTo"],
    message: "INVALID_DATE_RANGE",
  });
export type PatientSearch = z.infer<typeof patientSearchSchema>;
export const defaultPatientSearch: PatientSearch = {
  query: "",
  diagnoses: [],
  sex: "any",
  birthFrom: "",
  birthTo: "",
  sort: "recent",
};
const normalized = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const codes = (values: readonly string[]) => [
  ...new Set(values.map((code) => code.trim().toUpperCase()).filter(Boolean)),
];
const birthDateSchema = z.iso.date();

export function searchPatients(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
  filters: PatientSearch,
  now: number,
) {
  const parsed = patientSearchSchema.safeParse(filters);
  if (!parsed.success) return [];
  const input = parsed.data;
  if (role !== "doctor" && (input.birthFrom || input.birthTo)) return [];
  const query = normalized(input.query);
  const selectedCodes = codes(input.diagnoses);
  return source
    .filter((row) => {
      if (
        row.deleted ||
        (role === "researcher" &&
          (!row.consentApproved || !row.accessExpiresAt || row.accessExpiresAt <= now))
      )
        return false;
      const sexAllowed = role === "doctor" || row.consentScope.includes("sex");
      const diagnosesAllowed = role === "doctor" || row.consentScope.includes("diagnoses");
      const identity = role === "doctor" ? `${row.clientId} ${row.fullName}` : row.clientId;
      if (query && !normalized(identity).includes(query)) return false;
      if (
        input.sex === "unavailable"
          ? sexAllowed
          : input.sex !== "any" && (!sexAllowed || row.sex !== input.sex)
      )
        return false;
      if (selectedCodes.length) {
        if (!diagnosesAllowed) return false;
        const recordCodes = new Set(codes(row.diagnosisCodes));
        if (!selectedCodes.every((code) => recordCodes.has(code))) return false;
      }
      if (input.birthFrom && (!row.birthDate || row.birthDate < input.birthFrom)) return false;
      if (input.birthTo && (!row.birthDate || row.birthDate > input.birthTo)) return false;
      return true;
    })
    .sort((a, b) => {
      if (input.sort === "name" && role === "doctor")
        return (
          normalized(a.fullName).localeCompare(normalized(b.fullName)) ||
          a.clientId.localeCompare(b.clientId)
        );
      if (input.sort === "id" || input.sort === "name") return a.clientId.localeCompare(b.clientId);
      return b.updatedAt - a.updatedAt || a.clientId.localeCompare(b.clientId);
    });
}

// Exact demographic candidates only. No inference of identity and no automatic
// merge: consent, appointments and clinical history require an explicit review.
export function possiblePatientDuplicates(
  source: readonly PatientRow[],
  role: "doctor" | "researcher",
) {
  if (role !== "doctor") return [];
  const groups = new Map<string, PatientRow[]>();
  for (const row of source) {
    const name = normalized(row.fullName);
    if (row.deleted || !name || !birthDateSchema.safeParse(row.birthDate).success) continue;
    const key = JSON.stringify([name, row.birthDate]);
    const group = groups.get(key) ?? [];
    if (!group.some((entry) => entry.clientId === row.clientId)) group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((a, b) => a.clientId.localeCompare(b.clientId)))
    .sort((a, b) => b.length - a.length || a[0]!.clientId.localeCompare(b[0]!.clientId));
}
