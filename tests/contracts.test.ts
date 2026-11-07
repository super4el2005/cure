import { schemaResolver } from "@mantine/form";
import { expect, it } from "@rstest/core";

import {
  aiInputSchema,
  medicalFormSchema,
  medicalSearchSchema,
  medicalResultSchema,
} from "@/src/lib/contracts";
import { plainText } from "@/src/server/medical/http";

it("uses one wire contract for search validation and inferred payloads", () => {
  expect(medicalSearchSchema.parse({ source: "ror", query: "  medical  " })).toEqual({
    source: "ror",
    query: "medical",
  });
  expect(medicalSearchSchema.safeParse({ source: "ror", query: "a" }).success).toBe(false);
  expect(
    medicalSearchSchema.safeParse({
      source: "osm",
      query: "",
      latitude: "55",
      longitude: 37,
      radius: 5000,
    }).success,
  ).toBe(false);
  expect(
    medicalSearchSchema.safeParse({
      source: "osm",
      query: "",
      latitude: 91,
      longitude: 37,
      radius: 5000,
    }).success,
  ).toBe(false);
});
it("composes NumberInput form values through the installed Mantine schemaResolver", () => {
  const values = { source: "osm", query: "", latitude: "55", longitude: 37, radius: "5000" };
  const validate = schemaResolver(medicalFormSchema, { sync: true });
  expect(validate(values)).toEqual({});
  expect(medicalFormSchema.parse(values)).toEqual({
    source: "osm",
    query: "",
    latitude: 55,
    longitude: 37,
    radius: 5000,
  });
  expect(validate({ ...values, latitude: "" })).toHaveProperty("latitude");
  expect(validate({ ...values, radius: 10001 })).toHaveProperty("radius");
});
it("defaults to GigaChat but requires a model for BYOK and restricts message roles", () => {
  const messages = [{ role: "user", content: "Hello" }];
  expect(aiInputSchema.parse({ messages })).toMatchObject({ provider: "gigachat", model: "" });
  expect(aiInputSchema.safeParse({ provider: "openai", messages }).success).toBe(false);
  expect(
    aiInputSchema.safeParse({ messages: [{ role: "system", content: "Hello" }] }).success,
  ).toBe(false);
  expect(medicalResultSchema.safeParse({ records: [] }).success).toBe(false);
});
it("decodes HTML entities and strips markup with a real parser", () => {
  expect(plainText("<em>Asthma</em> &ndash; children&#x2019;s &amp; adults")).toBe(
    "Asthma – children’s & adults",
  );
  expect(plainText('<a href="https://example.org">Reference</a>')).toBe("Reference");
  expect(plainText("<script>private script</script><p>Visible</p>")).toBe("Visible");
});
