import { z } from "zod";

const common = {
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
  })
  .superRefine((value, ctx) => {
    if (new Set(value.fields.map((field) => field.id)).size !== value.fields.length)
      ctx.addIssue({ code: "custom", path: ["fields"], message: "DUPLICATE_FIELD_IDS" });
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
export function formAnswersSchema(definition: FormDefinition, final: boolean) {
  const fields: Record<string, z.ZodType> = {};
  for (const field of definition.fields) {
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
    fields[field.id] = final && field.required ? rule : rule.optional();
  }
  return z.strictObject(fields).pipe(answersSchema);
}
// Mantine inputs use an empty string for an unanswered control, including a
// required yes/no choice. Explicit false and zero remain real answers.
export function normalizeFormAnswers(definition: FormDefinition, input: Record<string, unknown>) {
  return Object.fromEntries(
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
