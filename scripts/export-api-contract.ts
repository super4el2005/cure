import { mkdir, writeFile } from "node:fs/promises";

import { createJiti } from "jiti";
import { z } from "zod";

const jiti = createJiti(import.meta.url, { alias: { "@": import.meta.dirname + "/.." } });
const schemas = await jiti.import<typeof import("@/src/lib/contracts")>("@/src/lib/contracts.ts");
const content = (schema: z.ZodType) => ({
  "application/json": { schema: z.toJSONSchema(schema, { unrepresentable: "any" }) },
});
const operation = (operationId: string, input: z.ZodType, output: z.ZodType) => ({
  post: {
    operationId,
    requestBody: { required: true, content: content(input) },
    responses: {
      "200": { description: "Success", content: content(output) },
      default: { description: "API error", content: content(schemas.apiErrorSchema) },
    },
  },
});
await mkdir("openapi", { recursive: true });
await writeFile(
  "openapi/cure.json",
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: { title: "Cure", version: "1.0.0" },
      paths: {
        "/api/medical/search": operation(
          "searchMedical",
          schemas.medicalSearchSchema,
          schemas.medicalResultSchema,
        ),
        "/api/ai/chat": operation("checkAi", schemas.aiInputSchema, schemas.aiResponseSchema),
      },
    },
    null,
    2,
  ) + "\n",
);
