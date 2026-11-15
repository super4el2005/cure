import { z } from "zod";

import { cohortCriteriaSchema, defaultCohortCriteria } from "@/src/lib/cohort-analysis";

export const fixedSampleSchema = z.object({
  frozenAt: z.number(),
  groupIds: z.array(z.uuid()).min(1).max(50000),
  referenceIds: z.array(z.uuid()).min(1).max(50000),
  signature: z.string().min(1).max(200),
});
export type FixedSample = z.infer<typeof fixedSampleSchema>;

export const cohortComparisonSchema = z
  .object({
    calculationVersion: z.literal("cohort-2x2-v1"),
    reference: cohortCriteriaSchema,
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("diagnosis"), code: z.string().trim().min(1).max(50) }),
      z.object({ kind: z.literal("sex"), value: z.enum(["female", "male"]) }),
    ]),
    confidence: z.union([z.literal(90), z.literal(95), z.literal(99)]),
    independent: z.boolean(),
    intent: z.enum(["exploratory", "prespecified"]),
    hypothesis: z.string().trim().max(2000),
    fixedSample: fixedSampleSchema.exactOptional(),
  })
  .refine((value) => value.intent !== "prespecified" || value.hypothesis.length > 0, {
    path: ["hypothesis"],
    message: "Hypothesis required",
  });
export type CohortComparison = z.infer<typeof cohortComparisonSchema>;
export const defaultCohortComparison: CohortComparison = {
  calculationVersion: "cohort-2x2-v1",
  reference: defaultCohortCriteria,
  outcome: { kind: "diagnosis", code: "" },
  confidence: 95,
  independent: false,
  intent: "exploratory",
  hypothesis: "",
};
