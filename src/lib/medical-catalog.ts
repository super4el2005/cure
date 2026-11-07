import { isPointWithinRadius } from "geolib";
import type { z } from "zod";

import type {
  medicalRecordSchema,
  medicalResultSchema,
  medicalSearchSchema,
} from "@/src/lib/contracts";

export const medicalSources = [
  "ror",
  "osm",
  "geofabrik",
  "icd11",
  "icd10",
  "pubmed",
  "orphadata",
] as const;
export type MedicalSource = (typeof medicalSources)[number];
export function isMedicalSource(value: unknown): value is MedicalSource {
  return medicalSources.some((source) => source === value);
}

export type MedicalRecord = z.infer<typeof medicalRecordSchema>;
export type MedicalSearch = z.infer<typeof medicalSearchSchema>;
export type MedicalResult = z.infer<typeof medicalResultSchema>;
export const medicalAttribution: Record<
  MedicalSource,
  { label: string; license: string; url: string }
> = {
  ror: { label: "Research Organization Registry", license: "CC0", url: "https://ror.org/" },
  osm: {
    label: "© OpenStreetMap contributors",
    license: "ODbL",
    url: "https://www.openstreetmap.org/copyright",
  },
  geofabrik: {
    label: "Geofabrik / © OpenStreetMap contributors",
    license: "ODbL",
    url: "https://www.geofabrik.de/data/download.html",
  },
  icd11: {
    label: "World Health Organization — ICD-11 MMS",
    license: "CC BY-ND 3.0 IGO",
    url: "https://icd.who.int/docs/icd-api/license/",
  },
  icd10: {
    label: "World Health Organization — ICD-10",
    license: "WHO terms of use",
    url: "https://icd.who.int/",
  },
  pubmed: {
    label: "PubMed / U.S. National Library of Medicine",
    license: "NLM terms; publisher rights apply",
    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
  },
  orphadata: {
    label: "Orphadata / Orphanet",
    license: "CC BY 4.0",
    url: "https://www.orphadata.com/",
  },
};

export function filterMedicalRecords(
  records: MedicalRecord[],
  source: MedicalSource,
  query: string,
  area?: Partial<
    Pick<Extract<MedicalSearch, { source: "osm" }>, "latitude" | "longitude" | "radius">
  >,
) {
  const needle = query.trim().toLocaleLowerCase();
  return records.filter(
    (record) =>
      record.source === source &&
      (source !== "osm" ||
        !area ||
        !Number.isFinite(area.latitude) ||
        !Number.isFinite(area.longitude) ||
        (record.latitude !== null &&
          record.longitude !== null &&
          isPointWithinRadius(
            { latitude: record.latitude, longitude: record.longitude },
            { latitude: area.latitude!, longitude: area.longitude! },
            area.radius ?? 5000,
          ))) &&
      `${record.title} ${record.code} ${record.description}`.toLocaleLowerCase().includes(needle),
  );
}
