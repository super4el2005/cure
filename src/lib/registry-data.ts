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
// Deterministic de-identified pseudonym (FNV-1a 64-bit over UTF-8). The input
// always contains a random UUID, so the code is stable for matching repeated
// observations of one participant without exposing identifiers.
export function registryPseudonym(input: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
export function registryParticipantCode(projectClientId: string, patientClientId: string) {
  return registryPseudonym(`${projectClientId}:${patientClientId}`);
}
export type DeidentifiedRegistryRow = {
  observationId: string;
  participantCode: string;
  occurredOn: string;
  formVersion: number;
  answers: Record<string, string | number | boolean | string[]>;
};
// Indicator ids a de-identified row may expose: the record's own registry
// config when present, otherwise the latest registry indicators that existed
// in that version's snapshot. Answers outside this set never leave the clinic
// rows, and neither do notes, names or record identifiers.
export function deidentifiedIndicatorIds(
  definition: FormDefinition,
  latestIndicators: readonly string[],
) {
  const own = definition.registry?.indicators;
  if (own) return new Set(own);
  const present = new Set(definition.fields.map((field) => field.id));
  return new Set(latestIndicators.filter((id) => present.has(id)));
}
export function deidentifiedRegistryRows(
  records: ClinicalRecord[],
  projectClientId: string,
  formClientId: string,
  latestIndicators: readonly string[],
) {
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
      const exposed = deidentifiedIndicatorIds(payload.definition, latestIndicators);
      return {
        observationId: registryPseudonym(`observation:${record.clientId}`),
        participantCode: registryParticipantCode(projectClientId, record.patientClientId),
        occurredOn: payload.occurredOn,
        formVersion: payload.formVersion,
        answers: Object.fromEntries(
          Object.entries(payload.answers).filter(([fieldId]) => exposed.has(fieldId)),
        ),
      };
    })
    .sort(
      (a, b) =>
        a.participantCode.localeCompare(b.participantCode) ||
        a.occurredOn.localeCompare(b.occurredOn) ||
        a.observationId.localeCompare(b.observationId),
    );
}
// Latest clinical observation per registry autofill mapping. Only number
// fields are autofillable; the physician still reviews and confirms the
// prefilled value before saving, so provenance stays manual entry.
export function registryAutofillAnswers(
  definition: FormDefinition,
  records: ClinicalRecord[],
): Record<string, number> {
  const rules = definition.registry?.autofill ?? [];
  if (rules.length === 0) return {};
  const latest = new Map<string, { occurredOn: string; updatedAt: number; value: number }>();
  for (const record of records) {
    if (record.deleted || record.payload?.kind !== "observation") continue;
    const { code, numericValue } = record.payload;
    if (!code || numericValue === null) continue;
    const current = latest.get(code);
    if (
      !current ||
      record.payload.occurredOn > current.occurredOn ||
      (record.payload.occurredOn === current.occurredOn && record.updatedAt > current.updatedAt)
    )
      latest.set(code, {
        occurredOn: record.payload.occurredOn,
        updatedAt: record.updatedAt,
        value: numericValue,
      });
  }
  return Object.fromEntries(
    rules.flatMap((rule) => {
      const match = latest.get(rule.observationCode);
      return match ? [[rule.fieldId, match.value]] : [];
    }),
  );
}
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
