import { z } from "zod";

import { aiProviders } from "@/src/lib/ai-providers";
import { medicalSources } from "@/src/lib/medical-catalog";

export const medicalSourceSchema = z.enum(medicalSources);
const query = z.string().trim().max(100);
const ordinarySearch = z.object({
  source: z.enum(["ror", "geofabrik", "icd11", "icd10", "orphadata"]),
  query: query.min(2),
});
const nearbySearch = z.object({
  source: z.literal("osm"),
  query,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius: z.number().min(100).max(10000),
});
const publicationSearch = z.object({
  source: z.literal("pubmed"),
  query: query.min(2),
  offset: z.number().int().min(0).max(9980).optional(),
});
export const medicalSearchSchema = z.discriminatedUnion("source", [
  ordinarySearch,
  nearbySearch,
  publicationSearch,
]);
// The form accepts empty NumberInput values; the wire contract requires numbers.
export const medicalFormSchema = z
  .object({
    source: medicalSourceSchema,
    query: z.string(),
    latitude: z.union([z.number(), z.string()]),
    longitude: z.union([z.number(), z.string()]),
    radius: z.union([z.number(), z.string()]),
  })
  .transform(({ source, query, latitude, longitude, radius }) =>
    source === "osm"
      ? {
          source,
          query,
          latitude: latitude === "" ? undefined : Number(latitude),
          longitude: longitude === "" ? undefined : Number(longitude),
          radius: radius === "" ? undefined : Number(radius),
        }
      : { source, query },
  )
  .pipe(medicalSearchSchema);

export const medicalRecordSchema = z.object({
  id: z.string(),
  source: medicalSourceSchema,
  sourceId: z.string(),
  bibliography: z
    .object({
      doi: z.string(),
      authors: z.array(z.string()),
      year: z.number().int().nullable(),
      journal: z.string(),
    })
    .optional(),
  title: z.string(),
  description: z.string(),
  code: z.string(),
  url: z.string(),
  dataLanguage: z.string(),
  version: z.string(),
  fetchedAt: z.string(),
  country: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});
export const medicalResultSchema = z.object({
  records: z.array(medicalRecordSchema),
  source: medicalSourceSchema,
  total: z.number().nullable(),
  truncated: z.boolean(),
  fetchedAt: z.string(),
  dataLanguage: z.string(),
});
export const apiErrorSchema = z.object({
  error: z.string(),
  stage: z.enum(["token", "lookup"]).optional(),
  upstreamStatus: z.number().optional(),
  failure: z.enum(["http", "network", "timeout", "json"]).optional(),
});
const aiMessagesSchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(8000),
    }),
  )
  .min(1)
  .max(32);
const aiCommon = { messages: aiMessagesSchema, baseURL: z.string().optional() };
export const aiInputSchema = z.discriminatedUnion("provider", [
  z.object({
    ...aiCommon,
    provider: z.literal("gigachat").default("gigachat"),
    model: z.string().default(""),
  }),
  z.object({
    ...aiCommon,
    provider: z.enum(aiProviders.map(({ id }) => id).filter((id) => id !== "gigachat")),
    model: z.string().trim().min(1).max(200),
  }),
]);
export const aiResponseSchema = z.object({
  text: z.string(),
  provider: z.enum(aiProviders.map(({ id }) => id)),
});
