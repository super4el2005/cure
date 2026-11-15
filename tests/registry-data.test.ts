import { describe, expect, it } from "@rstest/core";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import {
  groupRegistrySeries,
  registryAutofillAnswers,
  registryIndicators,
  registryObservations,
  registryValueText,
} from "@/src/lib/registry-data";
import { formDefinitionSchema } from "@/src/lib/study-form-model";
import type { FormDefinition, QuestionnairePayload } from "@/src/lib/study-form-model";

function definition(): FormDefinition {
  const common = { label: "Question", help: "", required: true };
  return {
    title: "Registry form",
    description: "",
    fields: [
      { ...common, id: crypto.randomUUID(), type: "number", minimum: 0, maximum: 300, unit: "мм" },
      {
        ...common,
        id: crypto.randomUUID(),
        type: "choice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      { ...common, id: crypto.randomUUID(), type: "boolean" },
    ],
  };
}
function registryDefinition(): FormDefinition {
  const form = definition();
  return {
    ...form,
    registry: { code: "REG-1", indicators: [form.fields[0]!.id, form.fields[1]!.id] },
  };
}
function record(overrides: {
  patientClientId: string;
  occurredOn: string;
  status?: "draft" | "final";
  deleted?: boolean;
  formClientId?: string;
  updatedAt?: number;
  updatedBy?: string;
  definition?: FormDefinition;
}): ClinicalRecord {
  const form = overrides.definition ?? registryDefinition();
  const payload: QuestionnairePayload = {
    kind: "questionnaire",
    writeId: crypto.randomUUID(),
    occurredOn: overrides.occurredOn,
    notes: "",
    projectClientId: crypto.randomUUID(),
    formVersionClientId: crypto.randomUUID(),
    formClientId: overrides.formClientId ?? crypto.randomUUID(),
    formVersion: 1,
    definition: form,
    answers: { [form.fields[0]!.id]: 120, [form.fields[1]!.id]: "a" },
    status: overrides.status ?? "final",
    amendmentReason: "",
  };
  return {
    clientId: crypto.randomUUID(),
    patientClientId: overrides.patientClientId,
    revision: 1,
    deleted: overrides.deleted ?? false,
    payload: overrides.deleted ? null : payload,
    createdAt: 1000,
    updatedAt: overrides.updatedAt ?? 1000,
    ...(overrides.updatedBy ? { updatedBy: overrides.updatedBy } : {}),
  };
}
describe("registry form definition", () => {
  it("accepts a valid registry config", () => {
    const form = registryDefinition();
    expect(formDefinitionSchema.parse(form)).toEqual(form);
  });
  it("keeps legacy definitions without registry unchanged", () => {
    const form = definition();
    const parsed = formDefinitionSchema.parse(form);
    expect(parsed).toEqual(form);
    expect("registry" in parsed).toBe(false);
  });
  it("rejects an unknown indicator field", () => {
    const form = registryDefinition();
    const invalid = {
      ...form,
      registry: { ...form.registry!, indicators: [crypto.randomUUID()] },
    };
    expect(formDefinitionSchema.safeParse(invalid).success).toBe(false);
  });
  it("rejects duplicate indicators and invalid codes", () => {
    const form = registryDefinition();
    const duplicated = {
      ...form,
      registry: {
        ...form.registry!,
        indicators: [form.fields[0]!.id, form.fields[0]!.id],
      },
    };
    expect(formDefinitionSchema.safeParse(duplicated).success).toBe(false);
    for (const code of ["", "код регистра", "code with spaces", "x".repeat(51)])
      expect(
        formDefinitionSchema.safeParse({
          ...form,
          registry: { ...form.registry!, code },
        }).success,
      ).toBe(false);
  });
});
describe("registry observations", () => {
  it("keeps only final responses of the requested form, sorted by date", () => {
    const formClientId = crypto.randomUUID();
    const patient = crypto.randomUUID();
    const rows = [
      record({ patientClientId: patient, occurredOn: "2026-03-01", formClientId }),
      record({
        patientClientId: patient,
        occurredOn: "2026-01-01",
        formClientId,
        updatedAt: 900,
      }),
      record({ patientClientId: patient, occurredOn: "2026-02-01", formClientId }),
      record({ patientClientId: patient, occurredOn: "2026-02-15", status: "draft" }),
      record({ patientClientId: patient, occurredOn: "2026-02-20", deleted: true }),
      record({ patientClientId: crypto.randomUUID(), occurredOn: "2026-02-10", formClientId }),
    ];
    const observations = registryObservations(rows, formClientId);
    expect(observations.map((row) => row.occurredOn)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-02-10",
      "2026-03-01",
    ]);
    expect(observations[0]!.method).toBe("manual");
    const series = groupRegistrySeries(observations);
    expect(series).toHaveLength(2);
    expect(series.find((row) => row.patientClientId === patient)?.observations).toHaveLength(3);
  });
  it("resolves indicator columns from the latest definition", () => {
    const form = registryDefinition();
    const indicators = registryIndicators(form);
    expect(indicators.map((field) => field.id)).toEqual(form.registry!.indicators);
    expect(registryIndicators(definition())).toEqual([]);
  });
  it("formats indicator values by field type", () => {
    const form = registryDefinition();
    const [numeric, choice, flag] = [form.fields[0]!, form.fields[1]!, form.fields[2]!];
    const labels = { yes: "Да", no: "Нет" };
    expect(registryValueText(numeric, 120, labels)).toBe("120 мм");
    expect(registryValueText(choice, "a", labels)).toBe("A");
    expect(registryValueText(choice, "unknown", labels)).toBe("");
    expect(registryValueText(flag, true, labels)).toBe("Да");
    expect(registryValueText(flag, false, labels)).toBe("Нет");
    expect(registryValueText(numeric, undefined, labels)).toBe("");
  });
});

function observation(overrides: {
  patientClientId: string;
  code: string;
  numericValue: number | null;
  occurredOn: string;
  updatedAt?: number;
  deleted?: boolean;
}): ClinicalRecord {
  return {
    clientId: crypto.randomUUID(),
    patientClientId: overrides.patientClientId,
    revision: 1,
    deleted: overrides.deleted ?? false,
    payload: overrides.deleted
      ? null
      : {
          kind: "observation",
          occurredOn: overrides.occurredOn,
          notes: "",
          name: "Indicator",
          code: overrides.code,
          numericValue: overrides.numericValue,
          textValue: "",
          unit: "",
        },
    createdAt: 1000,
    updatedAt: overrides.updatedAt ?? 1000,
  };
}
describe("registry autofill", () => {
  it("accepts autofill only for number indicators", () => {
    const form = registryDefinition();
    const valid = {
      ...form,
      registry: {
        ...form.registry!,
        autofill: [{ fieldId: form.fields[0]!.id, observationCode: "BP-SYS" }],
      },
    };
    expect(formDefinitionSchema.safeParse(valid).success).toBe(true);
    const notIndicator = {
      ...form,
      registry: {
        ...form.registry!,
        autofill: [{ fieldId: form.fields[2]!.id, observationCode: "BP-SYS" }],
      },
    };
    expect(formDefinitionSchema.safeParse(notIndicator).success).toBe(false);
    const duplicated = {
      ...form,
      registry: {
        ...form.registry!,
        autofill: [
          { fieldId: form.fields[0]!.id, observationCode: "BP-SYS" },
          { fieldId: form.fields[0]!.id, observationCode: "BP-DIA" },
        ],
      },
    };
    expect(formDefinitionSchema.safeParse(duplicated).success).toBe(false);
  });
  it("prefills from the latest matching clinical observation", () => {
    const form = registryDefinition();
    const definitionWithAutofill: FormDefinition = {
      ...form,
      registry: {
        ...form.registry!,
        autofill: [{ fieldId: form.fields[0]!.id, observationCode: "BP-SYS" }],
      },
    };
    const patient = crypto.randomUUID();
    const rows = [
      observation({
        patientClientId: patient,
        code: "BP-SYS",
        numericValue: 118,
        occurredOn: "2026-01-01",
      }),
      observation({
        patientClientId: patient,
        code: "BP-SYS",
        numericValue: 124,
        occurredOn: "2026-03-01",
      }),
      observation({
        patientClientId: patient,
        code: "BP-SYS",
        numericValue: 130,
        occurredOn: "2026-02-01",
        deleted: true,
      }),
      observation({
        patientClientId: patient,
        code: "BP-SYS",
        numericValue: null,
        occurredOn: "2026-04-01",
      }),
      observation({
        patientClientId: patient,
        code: "OTHER",
        numericValue: 200,
        occurredOn: "2026-05-01",
      }),
    ];
    expect(registryAutofillAnswers(definitionWithAutofill, rows)).toEqual({
      [form.fields[0]!.id]: 124,
    });
    expect(registryAutofillAnswers(registryDefinition(), rows)).toEqual({});
  });
});
