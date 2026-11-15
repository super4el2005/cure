import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { FormDefinition, StudyField } from "@/src/lib/study-form-model";

// One submitted final registry response: a single observation point of a
// patient in the registry. Provenance travels with the point: the author and
// the change time come from the clinical record, the source is the exact form
// version snapshot, and the collection method is manual physician entry until
// clinical-card autofill is connected.
export type RegistryObservation = {
  clientId: string;
  patientClientId: string;
  occurredOn: string;
  formVersion: number;
  updatedBy: string | undefined;
  updatedAt: number;
  method: "manual";
  definition: FormDefinition;
  answers: Record<string, string | number | boolean | string[]>;
};
export function registryObservations(records: ClinicalRecord[], formClientId: string) {
  return records
    .filter(
      (record) =>
        !record.deleted &&
        record.payload?.kind === "questionnaire" &&
        record.payload.formClientId === formClientId &&
        record.payload.status === "final",
    )
    .map((record) => {
      const payload = record.payload!;
      if (payload.kind !== "questionnaire") throw new Error("INVALID_CLINICAL_RECORD");
      return {
        clientId: record.clientId,
        patientClientId: record.patientClientId,
        occurredOn: payload.occurredOn,
        formVersion: payload.formVersion,
        updatedBy: record.updatedBy,
        updatedAt: record.updatedAt,
        method: "manual" as const,
        definition: payload.definition,
        answers: payload.answers,
      };
    })
    .sort(
      (a, b) =>
        a.occurredOn.localeCompare(b.occurredOn) ||
        a.updatedAt - b.updatedAt ||
        a.clientId.localeCompare(b.clientId),
    );
}
export type RegistrySeries = {
  patientClientId: string;
  observations: RegistryObservation[];
};
export function groupRegistrySeries(observations: RegistryObservation[]) {
  const map = new Map<string, RegistryObservation[]>();
  for (const observation of observations) {
    const rows = map.get(observation.patientClientId) ?? [];
    rows.push(observation);
    map.set(observation.patientClientId, rows);
  }
  return [...map.entries()]
    .map(([patientClientId, rows]) => ({ patientClientId, observations: rows }))
    .sort((a, b) => a.patientClientId.localeCompare(b.patientClientId));
}
// Indicator columns follow the latest registry definition. An indicator that
// disappeared from the latest version stays readable through each observation
// snapshot, but is not offered as a column.
export function registryIndicators(definition: FormDefinition) {
  const indicators = definition.registry?.indicators ?? [];
  return indicators
    .map((id) => definition.fields.find((field) => field.id === id))
    .filter((field): field is StudyField => Boolean(field));
}
export function registryValueText(
  field: StudyField,
  value: string | number | boolean | string[] | undefined,
  labels: { yes: string; no: string },
) {
  if (value === undefined) return "";
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? (value ? labels.yes : labels.no) : "";
    case "choice": {
      const choice = field.choices.find((row) => row.value === value);
      return choice?.label ?? "";
    }
    case "multiChoice": {
      if (!Array.isArray(value)) return "";
      return value
        .map((item) => field.choices.find((row) => row.value === item)?.label ?? "")
        .filter(Boolean)
        .join(", ");
    }
    case "number":
      if (typeof value !== "number") return "";
      return field.unit ? `${value} ${field.unit}` : String(value);
    default:
      return typeof value === "string" ? value : "";
  }
}
