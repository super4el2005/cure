import { describe, expect, it } from "@rstest/core";

import {
  calculateStudyScores,
  formAnswersSchema,
  formDefinitionSchema,
  normalizeFormAnswers,
  visibleStudyFields,
} from "@/src/lib/study-form-model";
import type { FormDefinition } from "@/src/lib/study-form-model";

function example(): FormDefinition {
  const gate = crypto.randomUUID(),
    number = crypto.randomUUID(),
    choice = crypto.randomUUID(),
    multi = crypto.randomUUID();
  const common = { label: "Question", help: "", required: true };
  return {
    title: "Researcher defined score",
    description: "Not a validated diagnostic instrument",
    fields: [
      { ...common, id: gate, type: "boolean" },
      {
        ...common,
        id: number,
        type: "number",
        minimum: 0,
        maximum: 10,
        unit: "",
        visibleWhen: { mode: "all", rules: [{ fieldId: gate, operator: "equals", value: false }] },
      },
      {
        ...common,
        id: choice,
        type: "choice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        visibleWhen: { mode: "any", rules: [{ fieldId: number, operator: "gte", value: 0 }] },
      },
      {
        ...common,
        id: multi,
        type: "multiChoice",
        choices: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        visibleWhen: {
          mode: "all",
          rules: [{ fieldId: choice, operator: "notEquals", value: "b" }],
        },
      },
    ],
    scores: [
      {
        id: crypto.randomUUID(),
        label: "Weighted sum",
        description: "Custom",
        unit: "points",
        method: "sum",
        terms: [
          { fieldId: number, weight: 2 },
          {
            fieldId: choice,
            weight: 1,
            mapping: [
              { value: "a", score: 3 },
              { value: "b", score: -1 },
            ],
          },
          {
            fieldId: multi,
            weight: 0.5,
            mapping: [
              { value: "a", score: 4 },
              { value: "b", score: 6 },
            ],
          },
        ],
      },
    ],
  };
}
function ids(form: FormDefinition) {
  return form.fields.map((field) => field.id);
}
describe("conditional forms and deterministic scores", () => {
  it("preserves old definitions exactly without adding optional schema keys", () => {
    const form = example();
    const legacy = {
      title: form.title,
      description: form.description,
      fields: [
        {
          id: form.fields[0]!.id,
          label: "Question",
          help: "",
          required: true,
          type: "boolean" as const,
        },
      ],
    };
    expect(formDefinitionSchema.parse(legacy)).toEqual(legacy);
    expect(JSON.stringify(formDefinitionSchema.parse(legacy))).toBe(JSON.stringify(legacy));
    expect(calculateStudyScores(legacy, {})).toEqual([]);
  });
  it("handles false and zero, nested branches, missing and invalid sources", () => {
    const form = example();
    const [gate, number, choice, multi] = ids(form) as [string, string, string, string];
    const answers = { [gate]: false, [number]: 0, [choice]: "a", [multi]: ["a", "b"] };
    expect([...visibleStudyFields(form, answers)]).toEqual(ids(form));
    expect(formAnswersSchema(form, true).parse(answers)).toEqual(answers);
    expect([...visibleStudyFields(form, { [gate]: true, [number]: 1, [choice]: "a" })]).toEqual([
      gate,
    ]);
    expect([...visibleStudyFields(form, { [gate]: false, [number]: 11, [choice]: "a" })]).toEqual([
      gate,
      number,
    ]);
    expect([...visibleStudyFields(form, { [gate]: false })]).toEqual([gate, number]);
    expect(formAnswersSchema(form, true).safeParse({ [gate]: false }).success).toBe(false);
    expect(formAnswersSchema(form, false).safeParse({ [gate]: false }).success).toBe(true);
    expect(formAnswersSchema(form, true).parse({ [gate]: true })).toEqual({ [gate]: true });
    expect(formAnswersSchema(form, true).safeParse({ ...answers, [gate]: true }).success).toBe(
      false,
    );
    expect(normalizeFormAnswers(form, { ...answers, [gate]: "true" })).toEqual({ [gate]: true });
    expect(normalizeFormAnswers(form, { ...answers, [gate]: "false" })).toEqual(answers);
    expect(
      formAnswersSchema(form, false).safeParse(normalizeFormAnswers(form, { unknown: "data" }))
        .success,
    ).toBe(false);
  });
  it("supports all/any conditions and multi-choice membership without treating an unanswered notEquals as true", () => {
    const form = example();
    const [gate, number, choice, multi] = ids(form) as [string, string, string, string];
    form.fields[3]!.visibleWhen = {
      mode: "any",
      rules: [
        { fieldId: choice, operator: "notEquals", value: "b" },
        { fieldId: gate, operator: "equals", value: true },
      ],
    };
    expect(visibleStudyFields(form, {}).has(multi)).toBe(false);
    expect(visibleStudyFields(form, { [gate]: true }).has(multi)).toBe(true);
    form.fields.push({
      id: crypto.randomUUID(),
      type: "text",
      label: "Follow up",
      help: "",
      required: true,
      maxLength: 100,
      visibleWhen: {
        mode: "all",
        rules: [
          { fieldId: multi, operator: "includes", value: "b" },
          { fieldId: number, operator: "lte", value: 5 },
        ],
      },
    });
    expect(formDefinitionSchema.safeParse(form).success).toBe(true);
    expect(
      visibleStudyFields(form, { [gate]: false, [number]: 5, [choice]: "a", [multi]: ["b"] }).size,
    ).toBe(5);
  });
  it("rejects cycles, forward or missing sources, incompatible operators, stale choices and ambiguous score mappings", () => {
    const base = example();
    const mutate = (change: (form: FormDefinition) => void) => {
      const form = structuredClone(base);
      change(form);
      expect(formDefinitionSchema.safeParse(form).success).toBe(false);
    };
    mutate((form) => {
      form.fields[0]!.visibleWhen = {
        mode: "all",
        rules: [{ fieldId: form.fields[0]!.id, operator: "equals", value: true }],
      };
    });
    mutate((form) => {
      form.fields.reverse();
    });
    mutate((form) => {
      form.fields.splice(0, 1);
    });
    mutate((form) => {
      form.fields[1]!.visibleWhen!.rules[0]!.operator = "gt";
    });
    mutate((form) => {
      form.fields[2]!.visibleWhen!.rules[0]!.value = "0";
    });
    mutate((form) => {
      form.fields[3]!.visibleWhen!.rules[0]!.value = "removed";
    });
    mutate((form) => {
      form.scores![0]!.terms[1]!.mapping!.pop();
    });
    mutate((form) => {
      form.scores![0]!.terms[1]!.mapping![1]!.value = "a";
    });
    mutate((form) => {
      form.scores![0]!.terms.push(form.scores![0]!.terms[0]!);
    });
    mutate((form) => {
      form.scores![0]!.terms[0]!.weight = 0;
    });
    mutate((form) => {
      form.scores![0]!.terms[0]!.fieldId = crypto.randomUUID();
    });
    mutate((form) => {
      form.scores!.push(form.scores![0]!);
    });
  });
  it("calculates declared coefficients and option scores with explicit missing and inapplicable results", () => {
    const form = example();
    const [gate, number, choice, multi] = ids(form) as [string, string, string, string];
    const answers = { [gate]: false, [number]: 2, [choice]: "a", [multi]: ["a", "b"] };
    expect(calculateStudyScores(form, answers)[0]).toMatchObject({
      status: "calculated",
      value: 12,
    });
    form.scores![0]!.method = "mean";
    expect(calculateStudyScores(form, answers)[0]).toMatchObject({
      status: "calculated",
      value: 4,
    });
    expect(calculateStudyScores(form, { ...answers, [gate]: true })[0]).toMatchObject({
      status: "notApplicable",
    });
    const missing = { ...answers };
    delete missing[multi];
    expect(calculateStudyScores(form, missing)[0]).toMatchObject({ status: "incomplete" });
    expect(calculateStudyScores(form, { ...answers, [multi]: ["invalid"] })[0]).toMatchObject({
      status: "invalid",
    });
    expect(calculateStudyScores(form, { ...answers, [multi]: ["a", "a"] })[0]).toMatchObject({
      status: "invalid",
    });
  });
  it("uses explicit boolean mappings and reports numeric overflow instead of a plausible value", () => {
    const form = example();
    const [gate, number] = ids(form) as [string, string];
    form.scores![0]!.terms = [
      {
        fieldId: gate,
        weight: 2,
        mapping: [
          { value: false, score: 0 },
          { value: true, score: 5 },
        ],
      },
    ];
    expect(formDefinitionSchema.safeParse(form).success).toBe(true);
    expect(calculateStudyScores(form, { [gate]: false })[0]).toMatchObject({
      status: "calculated",
      value: 0,
    });
    expect(calculateStudyScores(form, { [gate]: true })[0]).toMatchObject({
      status: "calculated",
      value: 10,
    });
    const numeric = form.fields[1]!;
    if (numeric.type !== "number") throw new Error("test setup");
    numeric.maximum = null;
    form.scores![0]!.terms = [{ fieldId: number, weight: 1000000 }];
    expect(calculateStudyScores(form, { [gate]: false, [number]: 1e308 })[0]).toMatchObject({
      status: "invalid",
    });
  });
});
