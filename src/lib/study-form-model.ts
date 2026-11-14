import { z } from "zod";

export const visibilityRuleSchema = z.object({
  fieldId: z.uuid(),
  operator: z.enum(["equals", "notEquals", "includes", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
});
export const visibilitySchema = z.object({
  mode: z.enum(["all", "any"]),
  rules: z.array(visibilityRuleSchema).min(1).max(10),
});
export const scoreSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  unit: z.string().trim().max(50),
  method: z.enum(["sum", "mean"]),
  terms: z
    .array(
      z.object({
        fieldId: z.uuid(),
        weight: z
          .number()
          .finite()
          .min(-1000000)
          .max(1000000)
          .refine((value) => value !== 0),
        mapping: z
          .array(
            z.object({
              value: z.union([z.string().max(50), z.boolean()]),
              score: z.number().finite().min(-1000000).max(1000000),
            }),
          )
          .max(50)
          .exactOptional(),
      }),
    )
    .min(1)
    .max(50),
});
export type StudyScore = z.infer<typeof scoreSchema>;
const common = {
  visibleWhen: visibilitySchema.exactOptional(),
  id: z.uuid(),
  label: z.string().trim().min(1).max(200),
  help: z.string().trim().max(1000),
  required: z.boolean(),
};
const choices = z
  .array(
    z.object({
      value: z
        .string()
        .trim()
        .regex(/^[a-zA-Z0-9_-]{1,50}$/),
      label: z.string().trim().min(1).max(200),
    }),
  )
  .min(1)
  .max(50)
  .refine(
    (rows) => new Set(rows.map((row) => row.value)).size === rows.length,
    "DUPLICATE_CHOICES",
  );
export const studyFieldSchema = z
  .discriminatedUnion("type", [
    z.object({ ...common, type: z.literal("text"), maxLength: z.number().int().min(1).max(10000) }),
    z.object({
      ...common,
      type: z.literal("number"),
      minimum: z.number().finite().nullable(),
      maximum: z.number().finite().nullable(),
      unit: z.string().trim().max(50),
    }),
    z.object({
      ...common,
      type: z.literal("date"),
      minDate: z.union([z.literal(""), z.iso.date()]),
      maxDate: z.union([z.literal(""), z.iso.date()]),
    }),
    z.object({ ...common, type: z.literal("boolean") }),
    z.object({ ...common, type: z.literal("choice"), choices }),
    z.object({ ...common, type: z.literal("multiChoice"), choices }),
  ])
  .superRefine((field, ctx) => {
    if (
      field.type === "number" &&
      field.minimum !== null &&
      field.maximum !== null &&
      field.minimum > field.maximum
    )
      ctx.addIssue({ code: "custom", path: ["maximum"], message: "INVALID_FIELD_RANGE" });
    if (field.type === "date" && field.minDate && field.maxDate && field.minDate > field.maxDate)
      ctx.addIssue({ code: "custom", path: ["maxDate"], message: "INVALID_FIELD_RANGE" });
  });
export type StudyField = z.infer<typeof studyFieldSchema>;
export const formDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000),
    fields: z.array(studyFieldSchema).min(1).max(50),
    scores: z.array(scoreSchema).max(20).exactOptional(),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.fields.map((field) => field.id)).size !== value.fields.length)
      ctx.addIssue({ code: "custom", path: ["fields"], message: "DUPLICATE_FIELD_IDS" });
    for (const [index, field] of value.fields.entries()) {
      for (const rule of field.visibleWhen?.rules ?? []) {
        const source = value.fields.slice(0, index).find((row) => row.id === rule.fieldId);
        const numeric = ["gt", "gte", "lt", "lte"].includes(rule.operator);
        const valid =
          source &&
          (source.type === "number"
            ? typeof rule.value === "number" && rule.operator !== "includes"
            : source.type === "boolean"
              ? typeof rule.value === "boolean" && ["equals", "notEquals"].includes(rule.operator)
              : source.type === "multiChoice"
                ? rule.operator === "includes" &&
                  source.choices.some((choice) => choice.value === rule.value)
                : source.type === "choice"
                  ? ["equals", "notEquals"].includes(rule.operator) &&
                    source.choices.some((choice) => choice.value === rule.value)
                  : !numeric &&
                    ["equals", "notEquals"].includes(rule.operator) &&
                    typeof rule.value === "string" &&
                    (source.type !== "date" || z.iso.date().safeParse(rule.value).success));
        if (!valid)
          ctx.addIssue({
            code: "custom",
            path: ["fields", index, "visibleWhen"],
            message: "INVALID_FORM_CONDITION",
          });
      }
    }
    const scores = value.scores ?? [];
    if (new Set(scores.map((score) => score.id)).size !== scores.length)
      ctx.addIssue({ code: "custom", path: ["scores"], message: "DUPLICATE_SCORE_IDS" });
    for (const [index, score] of scores.entries()) {
      if (new Set(score.terms.map((term) => term.fieldId)).size !== score.terms.length)
        ctx.addIssue({
          code: "custom",
          path: ["scores", index],
          message: "DUPLICATE_SCORE_FIELDS",
        });
      for (const [termIndex, term] of score.terms.entries()) {
        const field = value.fields.find((row) => row.id === term.fieldId);
        const expected =
          field?.type === "boolean"
            ? [false, true]
            : field?.type === "choice" || field?.type === "multiChoice"
              ? field.choices.map((choice) => choice.value)
              : null;
        const mapping = term.mapping ?? [];
        const valid =
          field?.type === "number"
            ? !mapping.length
            : expected &&
              mapping.length === expected.length &&
              new Set(mapping.map((item) => item.value)).size === mapping.length &&
              expected.every((value) => mapping.some((item) => item.value === value));
        if (!valid)
          ctx.addIssue({
            code: "custom",
            path: ["scores", index, "terms", termIndex],
            message: "INVALID_SCORE_TERM",
          });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 100000)
      ctx.addIssue({ code: "custom", path: ["fields"], message: "FORM_TOO_LARGE" });
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export const formVersionSchema = z.object({
  confirmed: z.boolean().default(false),
  baseVersionClientId: z.uuid().nullable().default(null),
  clientId: z.uuid(),
  formClientId: z.uuid(),
  projectClientId: z.uuid(),
  version: z.number().int().positive(),
  definition: formDefinitionSchema,
  status: z.enum(["published", "retired"]),
  createdAt: z.number(),
  createdBy: z.string(),
});
export type FormVersion = z.infer<typeof formVersionSchema>;
export type FormCommand = {
  baseVersionClientId: string | null;
  clientId: string;
  formClientId: string;
  projectClientId: string;
  expectedVersion: number;
  definition: FormDefinition;
  status: FormVersion["status"];
};
export const answerValueSchema = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()).max(50),
]);
export const answersSchema = z.record(z.string(), answerValueSchema);
export type FormAnswers = z.infer<typeof answersSchema>;
function fieldAnswerRule(field: StudyField) {
  let rule: z.ZodType;
  switch (field.type) {
    case "text":
      rule = z
        .string()
        .min(1)
        .max(field.maxLength)
        .refine((value) => value.trim().length > 0);
      break;
    case "number": {
      let numeric = z.number().finite();
      if (field.minimum !== null) numeric = numeric.min(field.minimum);
      if (field.maximum !== null) numeric = numeric.max(field.maximum);
      rule = numeric;
      break;
    }
    case "date":
      rule = z.iso
        .date()
        .refine(
          (value) =>
            (!field.minDate || value >= field.minDate) &&
            (!field.maxDate || value <= field.maxDate),
        );
      break;
    case "boolean":
      rule = z.boolean();
      break;
    case "choice":
      rule = z.string().refine((value) => field.choices.some((choice) => choice.value === value));
      break;
    case "multiChoice":
      rule = z
        .array(z.string())
        .min(1)
        .max(field.choices.length)
        .refine(
          (values) =>
            new Set(values).size === values.length &&
            values.every((value) => field.choices.some((choice) => choice.value === value)),
        );
      break;
  }
  return rule;
}
// Conditions can reference only preceding fields. A hidden, missing or invalid
// source never activates a branch, including a notEquals condition.
export function visibleStudyFields(definition: FormDefinition, answers: Record<string, unknown>) {
  const active = new Set<string>();
  for (const field of definition.fields) {
    const condition = field.visibleWhen;
    const matches = (rule: z.infer<typeof visibilityRuleSchema>) => {
      const source = definition.fields.find((row) => row.id === rule.fieldId);
      const answer = answers[rule.fieldId];
      if (!source || !active.has(source.id) || !fieldAnswerRule(source).safeParse(answer).success)
        return false;
      switch (rule.operator) {
        case "equals":
          return answer === rule.value;
        case "notEquals":
          return answer !== rule.value;
        case "includes":
          return Array.isArray(answer) && answer.includes(rule.value);
        case "gt":
          return (
            typeof answer === "number" && typeof rule.value === "number" && answer > rule.value
          );
        case "gte":
          return (
            typeof answer === "number" && typeof rule.value === "number" && answer >= rule.value
          );
        case "lt":
          return (
            typeof answer === "number" && typeof rule.value === "number" && answer < rule.value
          );
        case "lte":
          return (
            typeof answer === "number" && typeof rule.value === "number" && answer <= rule.value
          );
      }
    };
    if (
      !condition ||
      (condition.mode === "all" ? condition.rules.every(matches) : condition.rules.some(matches))
    )
      active.add(field.id);
  }
  return active;
}
export function formAnswersSchema(definition: FormDefinition, final: boolean) {
  const fields = Object.fromEntries(
    definition.fields.map((field) => [field.id, fieldAnswerRule(field).optional()]),
  );
  return z
    .strictObject(fields)
    .superRefine((answers, ctx) => {
      const active = visibleStudyFields(definition, answers);
      for (const field of definition.fields) {
        if (!active.has(field.id) && answers[field.id] !== undefined)
          ctx.addIssue({ code: "custom", path: [field.id], message: "HIDDEN_FORM_ANSWER" });
        else if (active.has(field.id) && final && field.required && answers[field.id] === undefined)
          ctx.addIssue({ code: "custom", path: [field.id], message: "REQUIRED_FORM_ANSWER" });
      }
    })
    .pipe(answersSchema);
}
export type StudyScoreResult = {
  score: StudyScore;
} & (
  | { status: "calculated"; value: number }
  | { status: "incomplete" | "notApplicable" | "invalid" }
);
export function calculateStudyScores(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): StudyScoreResult[] {
  const active = visibleStudyFields(definition, answers);
  return (definition.scores ?? []).map((score) => {
    if (score.terms.some((term) => !active.has(term.fieldId)))
      return { score, status: "notApplicable" };
    if (score.terms.some((term) => answers[term.fieldId] === undefined))
      return { score, status: "incomplete" };
    const values = score.terms.map((term) => {
      const field = definition.fields.find((row) => row.id === term.fieldId);
      const answer = answers[term.fieldId];
      if (!field || !fieldAnswerRule(field).safeParse(answer).success) return NaN;
      const mapped =
        typeof answer === "number"
          ? answer
          : Array.isArray(answer)
            ? answer.reduce(
                (sum, value) =>
                  sum + (term.mapping?.find((item) => item.value === value)?.score ?? NaN),
                0,
              )
            : (term.mapping?.find((item) => item.value === answer)?.score ?? NaN);
      return mapped * term.weight;
    });
    const value =
      values.reduce((sum, value) => sum + value, 0) /
      (score.method === "mean" ? score.terms.length : 1);
    return Number.isFinite(value)
      ? { score, status: "calculated", value }
      : { score, status: "invalid" };
  });
}
// Mantine inputs use an empty string for an unanswered control, including a
// required yes/no choice. Explicit false and zero remain real answers.
export function normalizeFormAnswers(definition: FormDefinition, input: Record<string, unknown>) {
  const values = Object.fromEntries(
    Object.entries(input)
      .filter(
        ([, value]) =>
          value !== "" &&
          value !== null &&
          value !== undefined &&
          (!Array.isArray(value) || value.length > 0),
      )
      .map(([id, value]) => {
        const field = definition.fields.find((row) => row.id === id);
        return [
          id,
          field?.type === "boolean" && (value === "true" || value === "false")
            ? value === "true"
            : value,
        ];
      }),
  );
  const active = visibleStudyFields(definition, values);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([id]) => active.has(id) || !definition.fields.some((field) => field.id === id),
    ),
  );
}
export const questionnairePayloadSchema = z
  .object({
    writeId: z.uuid(),
    kind: z.literal("questionnaire"),
    occurredOn: z.iso.date(),
    notes: z.string().trim().max(2000),
    projectClientId: z.uuid(),
    formVersionClientId: z.uuid(),
    formClientId: z.uuid(),
    formVersion: z.number().int().positive(),
    definition: formDefinitionSchema,
    answers: answersSchema,
    status: z.enum(["draft", "final"]),
    amendmentReason: z.string().trim().max(2000),
  })
  .superRefine((value, ctx) => {
    const result = formAnswersSchema(value.definition, value.status === "final").safeParse(
      value.answers,
    );
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({
          code: "custom",
          path: ["answers", ...issue.path],
          message: "INVALID_FORM_ANSWER",
        });
    if (new TextEncoder().encode(JSON.stringify(value.answers)).byteLength > 200000)
      ctx.addIssue({ code: "custom", path: ["answers"], message: "ANSWERS_TOO_LARGE" });
  });
export type QuestionnairePayload = z.infer<typeof questionnairePayloadSchema>;
