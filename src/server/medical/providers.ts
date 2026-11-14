import "@tanstack/react-start/server-only";
import { LRUCache } from "lru-cache";

import type { Locale } from "@/src/lib/locale";
import type { MedicalRecord, MedicalResult, MedicalSearch } from "@/src/lib/medical-catalog";
import {
  queryReferencesByName,
  queryReferencesByOrphacode,
} from "@/src/server/medical/generated/orphadata";
import {
  jsonFetch,
  MedicalApiError,
  object,
  plainText,
  rows,
  safeUrl,
  text,
} from "@/src/server/medical/http";
import { createWhoClient } from "@/src/server/medical/who";

export function createMedicalProviders(
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
) {
  const who = createWhoClient(fetchImpl, env);
  const regions = new LRUCache<string, Record<string, unknown>[]>({
    max: 1,
    ttl: 86_400_000,
    fetchMethod: async () => {
      const data = await jsonFetch(fetchImpl, "https://download.geofabrik.de/index-v1.json");
      return rows(data.features).map((feature) => object(feature.properties));
    },
  });
  return async (input: MedicalSearch, locale: Locale): Promise<MedicalResult> => {
    const stamp = new Date().toISOString();
    const record = (
      value: Partial<MedicalRecord> & Pick<MedicalRecord, "sourceId" | "title">,
    ): MedicalRecord => ({
      source: input.source,
      id: `${input.source}:${value.sourceId}`,
      description: "",
      code: "",
      url: "",
      dataLanguage: "en",
      version: "",
      fetchedAt: stamp,
      country: "",
      latitude: null,
      longitude: null,
      ...value,
    });
    let all: MedicalRecord[] = [];
    let total: number | null = null;
    let language = "en";
    if (input.source === "icd10" || input.source === "icd11") {
      const result = await who(input, locale, stamp);
      return {
        source: input.source,
        records: result.records,
        total: result.total,
        truncated: result.total === null || result.total > result.records.length,
        fetchedAt: stamp,
        dataLanguage: result.language,
      };
    }
    if (input.source === "ror") {
      const url = new URL("https://api.ror.org/v2/organizations");
      url.searchParams.set("query", input.query);
      url.searchParams.set("filter", "types:education");
      const data = await jsonFetch(fetchImpl, url);
      total = typeof data.number_of_results === "number" ? data.number_of_results : null;
      all = rows(data.items).map((item) => {
        const names = rows(item.names);
        const display =
          names.find((name) => Array.isArray(name.types) && name.types.includes("ror_display")) ??
          names[0] ??
          {};
        const location = rows(item.locations)[0];
        const geo = location?.geonames_details ? object(location.geonames_details) : {};
        return record({
          sourceId: text(item.id),
          title: text(display.value),
          dataLanguage: text(display.lang) || "und",
          url: safeUrl(item.id),
          country: text(geo.country_code),
          latitude: typeof geo.lat === "number" ? geo.lat : null,
          longitude: typeof geo.lng === "number" ? geo.lng : null,
          description: names
            .map((name) => text(name.value))
            .join(" · ")
            .slice(0, 600),
          version: item.admin ? text(object(object(item.admin).last_modified).date) : "",
        });
      });
      language = "multilingual";
    } else if (input.source === "osm") {
      const { latitude, longitude } = input;
      const radius = input.radius ?? 5000;
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude!) > 90 ||
        Math.abs(longitude!) > 180 ||
        radius < 100 ||
        radius > 10000
      )
        throw new MedicalApiError("INVALID_SEARCH", 400);
      const area = `(around:${radius},${latitude},${longitude})`;
      // Query terms never become executable Overpass syntax.
      const literal = JSON.stringify(input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const name = input.query ? `["name"~${literal},i]` : "";
      const query = `[out:json][timeout:12];(nwr["amenity"~"^(hospital|clinic|doctors)$"]${name}${area};nwr["healthcare"~"^(hospital|clinic|doctor)$"]${name}${area};);out tags center 100;`;
      const data = await jsonFetch(fetchImpl, "https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
      });
      if (data.remark) throw new MedicalApiError("SOURCE_UNAVAILABLE");
      all = rows(data.elements).map((item) => {
        const tags = item.tags ? object(item.tags) : {};
        const center = item.center ? object(item.center) : item;
        const sourceId = `${text(item.type)}/${item.id}`;
        return record({
          sourceId,
          title: text(tags[`name:${locale}`]) || text(tags.name) || sourceId,
          url: safeUrl(`https://www.openstreetmap.org/${sourceId}`),
          description: [
            tags.healthcare,
            tags["addr:city"],
            tags["addr:street"],
            tags["addr:housenumber"],
          ]
            .map(text)
            .filter(Boolean)
            .join(" · "),
          dataLanguage: "und",
          latitude: typeof center.lat === "number" ? center.lat : null,
          longitude: typeof center.lon === "number" ? center.lon : null,
          version: data.osm3s ? text(object(data.osm3s).timestamp_osm_base) : "",
        });
      });
      // Overpass's bounded result does not tell us the full local count.
      total = null;
      language = "multilingual";
    } else if (input.source === "geofabrik") {
      const features = await regions.fetch("regions");
      const matches = (features ?? []).filter((item) =>
        `${text(item.name)} ${text(item.id)}`.toLowerCase().includes(input.query.toLowerCase()),
      );
      total = matches.length;
      all = matches.slice(0, 20).map((item) =>
        record({
          sourceId: text(item.id),
          title: text(item.name),
          url: safeUrl(object(item.urls).pbf),
          description: "OpenStreetMap PBF",
          version: "latest",
        }),
      );
    } else if (input.source === "pubmed") {
      const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
      url.search = new URLSearchParams({
        db: "pubmed",
        term: input.query,
        retmode: "json",
        retmax: "20",
        retstart: String(input.offset ?? 0),
        tool: "cure",
      }).toString();
      if (env.NCBI_API_KEY) url.searchParams.set("api_key", env.NCBI_API_KEY);
      const data = object((await jsonFetch(fetchImpl, url)).esearchresult);
      if (data.errorlist) throw new MedicalApiError("INVALID_SEARCH", 400);
      const ids = Array.isArray(data.idlist)
        ? data.idlist.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
        : [];
      total = /^\d+$/.test(text(data.count)) ? Number(data.count) : null;
      if (ids.length) {
        const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
        summary.search = new URLSearchParams({
          db: "pubmed",
          id: ids.join(","),
          retmode: "json",
          tool: "cure",
        }).toString();
        if (env.NCBI_API_KEY) summary.searchParams.set("api_key", env.NCBI_API_KEY);
        const result = object((await jsonFetch(fetchImpl, summary)).result);
        all = ids.map((id) => {
          const item = object(result[id]);
          return record({
            sourceId: id,
            bibliography: {
              doi: text(rows(item.articleids).find((value) => text(value.idtype) === "doi")?.value),
              authors: rows(item.authors)
                .map((value) => plainText(value.name))
                .filter(Boolean),
              year: /\b(?:1[5-9]\d{2}|20\d{2}|21\d{2}|2200)\b/.test(text(item.pubdate))
                ? Number(text(item.pubdate).match(/\b(?:1[5-9]\d{2}|20\d{2}|21\d{2}|2200)\b/)![0])
                : null,
              journal: plainText(item.fulljournalname),
            },
            code: `PMID:${id}`,
            title: plainText(item.title),
            url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
            description: [item.fulljournalname, item.pubdate].map(text).filter(Boolean).join(" · "),
            version: text(item.pubdate),
            dataLanguage: "und",
          });
        });
      }
    } else if (input.source === "orphadata") {
      const query = input.query.replace(/^ORPHA:/i, "").trim();
      const options = {
        env: { fetch: fetchImpl },
        validateStatus: (status: number) => (status >= 200 && status < 300) || status === 404,
      };
      const response = object(
        /^\d+$/.test(query)
          ? await queryReferencesByOrphacode(Number(query), { lang: "en" }, options)
          : await queryReferencesByName(query, { lang: "en" }, options),
      );
      const data = response.data ? object(response.data) : {};
      const results = Array.isArray(data.results)
        ? rows(data.results)
        : data.results && typeof data.results === "object"
          ? [object(data.results)]
          : [];
      total = typeof data.__count === "number" ? data.__count : results.length;
      all = results.map((item) =>
        record({
          sourceId: String(item.ORPHAcode),
          title: text(item["Preferred term"]),
          code: `ORPHA:${item.ORPHAcode}`,
          url: safeUrl(item.OrphanetURL),
          version: text(item.Date),
          description: rows(item.SummaryInformation)
            .map((info) => plainText(info.Definition))
            .join(" ")
            .slice(0, 600),
        }),
      );
    }
    const unique = [
      ...new Map(
        all.filter((item) => item.sourceId && item.title).map((item) => [item.id, item]),
      ).values(),
    ];
    const limit = input.source === "osm" ? 100 : 20;
    return {
      source: input.source,
      records: unique.slice(0, limit),
      total,
      truncated:
        total === null || total > limit + (input.source === "pubmed" ? (input.offset ?? 0) : 0),
      fetchedAt: stamp,
      dataLanguage: language,
    };
  };
}
