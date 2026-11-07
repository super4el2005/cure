import { defineConfig } from "orval";
import type { InputTransformerFn } from "orval";

const selectOperations =
  (ids: string[]): InputTransformerFn =>
  (schema) => {
    for (const item of Object.values(schema.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (
          method === "get" &&
          operation &&
          typeof operation === "object" &&
          "operationId" in operation &&
          ids.includes(String(operation.operationId))
        )
          Object.assign(operation, { tags: ["CureUsed"] });
      }
    }
    return schema;
  };

export default defineConfig({
  cure: {
    input: "./openapi/cure.json",
    output: {
      target: "./src/lib/generated/cure.ts",
      tsconfig: "./tsconfig.json",
      formatter: "oxfmt",
      client: "react-query",
      httpClient: "axios",
      override: { mutator: { path: "@/src/lib/http-client", name: "apiClient" } },
    },
  },
  who: {
    input: {
      target: "./openapi/vendor/who.json",
      filters: { mode: "include", tags: ["CureUsed"] },
      override: { transformer: selectOperations(["GetICD10Entity", "SearchLinearization"]) },
    },
    output: {
      target: "./src/server/medical/generated/who.ts",
      tsconfig: "./tsconfig.json",
      formatter: "oxfmt",
      client: "axios-functions",
      urlEncodeParameters: true,
      baseUrl: "https://id.who.int",
      override: { mutator: { path: "@/src/server/medical/http", name: "medicalRequest" } },
    },
  },
  orphadata: {
    input: {
      target: "./openapi/vendor/orphadata.json",
      filters: { mode: "include", tags: ["CureUsed"] },
      override: {
        transformer: selectOperations([
          "query_references_by_name",
          "query_references_by_orphacode",
        ]),
      },
    },
    output: {
      target: "./src/server/medical/generated/orphadata.ts",
      tsconfig: "./tsconfig.json",
      formatter: "oxfmt",
      client: "axios-functions",
      urlEncodeParameters: true,
      baseUrl: "https://api.orphadata.com",
      override: { mutator: { path: "@/src/server/medical/http", name: "medicalRequest" } },
    },
  },
});
