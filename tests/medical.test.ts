import { expect, it, rstest } from "@rstest/core";

import { createMedicalCache, saveMedicalRecords } from "@/src/lib/medical-cache";
import { filterMedicalRecords } from "@/src/lib/medical-catalog";
import type { MedicalRecord, MedicalResult } from "@/src/lib/medical-catalog";
import { createMedicalProviders } from "@/src/server/medical/providers";
import { createMedicalHandler } from "@/src/server/medical/search";
import { createWhoClient } from "@/src/server/medical/who";

const entry: MedicalRecord = {
  id: "ror:1",
  source: "ror",
  sourceId: "1",
  title: "Medical University",
  description: "",
  code: "",
  url: "https://ror.org/1",
  dataLanguage: "en",
  version: "2026",
  fetchedAt: "2026-11-07",
  country: "GB",
  latitude: null,
  longitude: null,
};
const result: MedicalResult = {
  source: "ror",
  records: [entry],
  total: 1,
  truncated: false,
  fetchedAt: entry.fetchedAt,
  dataLanguage: "en",
};
function fixtureFetch(
  bodies: unknown[],
  seen: Array<{ url: string; init?: RequestInit | undefined }> = [],
): typeof fetch {
  return async (input, init) => {
    seen.push(
      input instanceof Request
        ? {
            url: input.url,
            init: {
              method: input.method,
              headers: input.headers,
              body: await input.clone().text(),
            },
          }
        : { url: String(input), init },
    );
    const body = bodies.shift();
    if (body instanceof Response) return body;
    if (body === undefined) throw new Error("Unexpected upstream request");
    return Response.json(body);
  };
}
function request(body: unknown, origin = "https://cure.example") {
  return new Request("https://cure.example/api/medical/search", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("normalizes ROR v2 educational organizations and provenance", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const search = createMedicalProviders(
    fixtureFetch(
      [
        {
          number_of_results: 22,
          items: [
            {
              id: "https://ror.org/1",
              names: [{ value: "Medical University", lang: "en", types: ["ror_display"] }],
              locations: [{ geonames_details: { country_code: "GB", lat: 51, lng: 0 } }],
              admin: { last_modified: { date: "2026-01-01" } },
            },
          ],
        },
      ],
      seen,
    ),
  );
  const response = await search({ source: "ror", query: "medical" }, "ru");
  expect(new URL(seen[0]!.url).searchParams.get("filter")).toBe("types:education");
  expect(response.records[0]).toMatchObject({
    title: "Medical University",
    country: "GB",
    latitude: 51,
    version: "2026-01-01",
  });
  expect(response.truncated).toBe(true);
});

it("uses WHO OAuth once, requested ICD-11 locale and direct ICD-10 code lookup", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const who = createWhoClient(
    fixtureFetch(
      [
        { token_type: "Bearer", access_token: "private-token", expires_in: 3600 },
        {
          destinationEntities: [
            { id: "http://id.who.int/icd/entity/1", title: "<em>Астма</em>", theCode: "CA23" },
          ],
          resultChopped: false,
        },
        {
          "@id": "http://id.who.int/icd/release/10/2019/J45",
          title: { "@value": "Asthma" },
          code: "J45",
        },
      ],
      seen,
    ),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  const eleven = await who({ source: "icd11", query: "астма" }, "ru", "today");
  const ten = await who({ source: "icd10", query: "j45" }, "ru", "today");
  expect(eleven.records[0]).toMatchObject({
    title: "Астма",
    code: "CA23",
    dataLanguage: "ru",
    version: "2026-01",
  });
  expect(ten.records[0]).toMatchObject({ title: "Asthma", dataLanguage: "en" });
  expect(seen).toHaveLength(3);
  expect(seen[2]!.url).toBe("https://id.who.int/icd/release/10/2019/J45");
  expect(JSON.stringify(eleven)).not.toContain("private-token");
});

it("distinguishes missing WHO credentials and unknown ICD-10 code", async () => {
  await expect(
    createWhoClient(fixtureFetch([]), {})({ source: "icd11", query: "asthma" }, "en", "now"),
  ).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED", status: 503 });
  const who = createWhoClient(
    fixtureFetch([
      { token_type: "Bearer", access_token: "t", expires_in: 3600 },
      new Response(null, { status: 404 }),
    ]),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  expect((await who({ source: "icd10", query: "Z99" }, "ru", "now")).records).toEqual([]);
});

it("loads PubMed summaries without returning credentials or full articles", async () => {
  const search = createMedicalProviders(
    fixtureFetch([
      { esearchresult: { count: "100", idlist: ["123"] } },
      {
        result: {
          "123": {
            title: "<i>Asthma</i> in children",
            fulljournalname: "Journal",
            pubdate: "2026 Nov",
            authors: [{ name: "Author One" }, { name: "<i>Author Two</i>" }],
            articleids: [{ idtype: "doi", value: "10.1234/example" }],
          },
        },
      },
    ]),
    { NCBI_API_KEY: "secret" },
  );
  const value = await search({ source: "pubmed", query: "asthma AND children" }, "ru");
  expect(value.records[0]).toMatchObject({
    title: "Asthma in children",
    code: "PMID:123",
    url: "https://pubmed.ncbi.nlm.nih.gov/123/",
    bibliography: {
      doi: "10.1234/example",
      authors: ["Author One", "Author Two"],
      year: 2026,
      journal: "Journal",
    },
  });
  expect(value.truncated).toBe(true);
  expect(JSON.stringify(value)).not.toContain("secret");
});

it("handles Orphadata single-object results and no match", async () => {
  const search = createMedicalProviders(
    fixtureFetch([
      {
        data: {
          __count: 1,
          results: {
            ORPHAcode: 84,
            "Preferred term": "Marfan syndrome",
            OrphanetURL: "https://www.orpha.net/en/disease/detail/84",
            SummaryInformation: [{ Definition: "Connective tissue disorder" }],
          },
        },
      },
      new Response(null, { status: 404 }),
    ]),
  );
  expect((await search({ source: "orphadata", query: "ORPHA:84" }, "ru")).records[0]).toMatchObject(
    { code: "ORPHA:84", title: "Marfan syndrome" },
  );
  expect((await search({ source: "orphadata", query: "unknown" }, "en")).records).toEqual([]);
});

it("bounds OSM requests and keeps coordinates and OSM attribution identity", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const search = createMedicalProviders(
    fixtureFetch(
      [
        {
          elements: [
            {
              type: "way",
              id: 42,
              tags: { name: "Clinic", "name:ru": "Клиника" },
              center: { lat: 55, lon: 37 },
            },
          ],
        },
      ],
      seen,
    ),
  );
  const value = await search(
    { source: "osm", query: "", latitude: 55, longitude: 37, radius: 1000 },
    "ru",
  );
  expect(value.records[0]).toMatchObject({
    sourceId: "way/42",
    title: "Клиника",
    latitude: 55,
    longitude: 37,
    url: "https://www.openstreetmap.org/way/42",
  });
  expect(String(seen[0]!.init?.body)).toContain("around%3A1000%2C55%2C37");
  await expect(
    search({ source: "osm", query: "", latitude: 55, longitude: 37, radius: 10001 }, "en"),
  ).rejects.toMatchObject({ code: "INVALID_SEARCH" });
});

it("uses Geofabrik's region index without downloading PBF archives", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const search = createMedicalProviders(
    fixtureFetch(
      [
        {
          features: [
            {
              properties: {
                id: "germany",
                name: "Germany",
                urls: { pbf: "https://download.geofabrik.de/europe/germany-latest.osm.pbf" },
              },
            },
          ],
        },
      ],
      seen,
    ),
  );
  const value = await search({ source: "geofabrik", query: "germany" }, "en");
  await search({ source: "geofabrik", query: "german" }, "en");
  expect(seen).toHaveLength(1);
  expect(value.records[0]!.url).toContain("germany-latest.osm.pbf");
});

it("validates public gateway input and deduplicates concurrent source calls", async () => {
  let calls = 0;
  const handler = createMedicalHandler(async () => {
    calls++;
    return result;
  });
  expect(
    (await handler(request({ source: "ror", query: "medical" }, "https://other.example"), "ru"))
      .status,
  ).toBe(403);
  expect((await handler(request({ source: "http://evil", query: "medical" }), "ru")).status).toBe(
    400,
  );
  expect(
    (
      await handler(
        request({ source: "osm", query: "", latitude: "55", longitude: 37, radius: 5000 }),
        "ru",
      )
    ).status,
  ).toBe(400);
  const responses = await Promise.all([
    handler(request({ source: "ror", query: "medical" }), "ru"),
    handler(request({ source: "ror", query: "medical" }), "ru"),
  ]);
  expect(calls).toBe(1);
  expect(responses[0]!.headers.get("cache-control")).toBe("private, no-store");
  expect(await responses[1]!.json()).toEqual(result);
});

it("does not cache outages or reveal upstream errors", async () => {
  let calls = 0;
  const handler = createMedicalHandler(async () => {
    calls++;
    throw new Error("secret upstream URL");
  });
  for (let i = 0; i < 2; i++) {
    const response = await handler(request({ source: "ror", query: "medical" }), "en");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "SOURCE_UNAVAILABLE" });
  }
  expect(calls).toBe(2);
  const search = createMedicalProviders(fixtureFetch([new Response(null, { status: 429 })]));
  await expect(search({ source: "ror", query: "medical" }, "en")).rejects.toMatchObject({
    code: "SOURCE_RATE_LIMITED",
    status: 429,
  });
});

it("restores downloaded records from persistent storage into a fresh TanStack DB collection", async () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  const first = createMedicalCache(storage);
  await saveMedicalRecords(first, [entry]);
  await first.cleanup();
  const restored = createMedicalCache(storage);
  expect(await restored.toArrayWhenReady()).toMatchObject([entry]);
  await saveMedicalRecords(restored, [{ ...entry, title: "Updated university" }]);
  expect(restored.toArray).toHaveLength(1);
  await restored.cleanup();
  const updated = createMedicalCache(storage);
  expect(await updated.toArrayWhenReady()).toMatchObject([
    { ...entry, title: "Updated university" },
  ]);
  await updated.cleanup();
});

it("filters offline OSM facilities by location as well as text", () => {
  const nearby = {
    ...entry,
    id: "osm:1",
    source: "osm" as const,
    title: "Clinic",
    latitude: 55,
    longitude: 37,
  };
  const far = { ...nearby, id: "osm:2", latitude: 56 };
  expect(
    filterMedicalRecords([nearby, far], "osm", "clinic", {
      latitude: 55,
      longitude: 37,
      radius: 1000,
    }),
  ).toEqual([nearby]);
});

it("reports storage failure instead of confirming offline persistence", async () => {
  const storage: Storage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new Error("Storage quota exceeded");
    },
    removeItem: () => {},
    clear: () => {},
  };
  const log = rstest.spyOn(console, "error").mockImplementation(() => {});
  const collection = createMedicalCache(storage);
  try {
    await expect(saveMedicalRecords(collection, [entry])).rejects.toThrow("Storage quota exceeded");
  } finally {
    await collection.cleanup();
    log.mockRestore();
  }
});

it("uses documented WHO Basic client authentication and resolves F41 with server-only credentials", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const who = createWhoClient(
    fixtureFetch(
      [
        { token_type: "Bearer", access_token: "private-token", expires_in: 3600 },
        {
          "@id": "http://id.who.int/icd/release/10/2019/F41",
          title: { "@value": "Other anxiety disorders" },
          code: "F41",
        },
      ],
      seen,
    ),
    { WHO_ICD_CLIENT_ID: " client-id\n", WHO_ICD_CLIENT_SECRET: " client-secret\r\n" },
  );
  const result = await who({ source: "icd10", query: "F41" }, "ru", "now");
  expect(result.records[0]).toMatchObject({
    code: "F41",
    title: "Other anxiety disorders",
    dataLanguage: "en",
  });
  const headers = new Headers(seen[0]!.init?.headers);
  expect(
    Buffer.from(headers.get("authorization")!.slice(6), "base64")
      .toString()
      .split(":")
      .map(decodeURIComponent),
  ).toEqual(["client-id", "client-secret"]);
  expect(new URLSearchParams(String(seen[0]!.init?.body)).get("scope")).toBe("icdapi_access");
  expect(new URLSearchParams(String(seen[0]!.init?.body)).get("grant_type")).toBe(
    "client_credentials",
  );
  expect(new Headers(seen[1]!.init?.headers).get("authorization")).toBe("Bearer private-token");
  expect(seen[1]!.url).toBe("https://id.who.int/icd/release/10/2019/F41");
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it("distinguishes WHO token rejection from a source outage without leaking the OAuth body", async () => {
  const providers = createMedicalProviders(
    fixtureFetch([
      new Response(
        JSON.stringify({ error: "invalid_client", error_description: "secret private diagnostic" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ]),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  const response = await createMedicalHandler(providers)(
    request({ source: "icd10", query: "F41" }),
    "en",
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "SOURCE_AUTH_FAILED",
    stage: "token",
    upstreamStatus: 400,
    failure: "http",
  });
});

it("refreshes a WHO token revoked before its advertised expiry exactly once", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const who = createWhoClient(
    fixtureFetch(
      [
        { token_type: "Bearer", access_token: "stale", expires_in: 3600 },
        new Response(null, { status: 401 }),
        { token_type: "Bearer", access_token: "renewed", expires_in: 3600 },
        { title: { "@value": "Other anxiety disorders" }, code: "F41" },
      ],
      seen,
    ),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  expect((await who({ source: "icd10", query: "F41" }, "en", "now")).records[0]!.code).toBe("F41");
  expect(seen).toHaveLength(4);
  expect(new Headers(seen[3]!.init?.headers).get("authorization")).toBe("Bearer renewed");
});

it("does not retry WHO authorization indefinitely", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const who = createWhoClient(
    fixtureFetch(
      [
        { token_type: "Bearer", access_token: "stale", expires_in: 3600 },
        new Response(null, { status: 401 }),
        { token_type: "Bearer", access_token: "renewed", expires_in: 3600 },
        new Response(null, { status: 401 }),
      ],
      seen,
    ),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  await expect(who({ source: "icd10", query: "F41" }, "en", "now")).rejects.toMatchObject({
    code: "SOURCE_AUTH_FAILED",
    status: 503,
    details: { stage: "lookup", upstreamStatus: 401 },
  });
  expect(seen).toHaveLength(4);
});

it("preserves safe WHO failure stage for transport failures", async () => {
  const who = createWhoClient(
    async () => {
      throw new TypeError("secret URL and credentials");
    },
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  await expect(who({ source: "icd10", query: "F41" }, "en", "now")).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
    details: { stage: "token", failure: "network" },
  });
});

it("separates cached results by request locale and evicts least recently used entries", async () => {
  let calls = 0;
  const handler = createMedicalHandler(async (_input, locale) => {
    calls++;
    return { ...result, dataLanguage: locale };
  });
  const get = (query: string, locale: "ru" | "en" = "en") =>
    handler(request({ source: "ror", query }), locale);
  await get("medical", "en");
  const russian = await get("medical", "ru");
  expect((await russian.json()).dataLanguage).toBe("ru");
  expect(calls).toBe(2);
  for (let i = 0; i < 98; i++) await get(`university-${i}`);
  await get("medical", "en"); // Touch the oldest entry so it survives LRU eviction.
  expect(calls).toBe(100);
  await get("additional");
  await get("medical", "en");
  expect(calls).toBe(101);
  await get("medical", "ru");
  expect(calls).toBe(102);
});

it("keeps upstream HTTP details when an OAuth rejection is not JSON", async () => {
  const who = createWhoClient(fixtureFetch([new Response("private details", { status: 401 })]), {
    WHO_ICD_CLIENT_ID: "id",
    WHO_ICD_CLIENT_SECRET: "secret",
  });
  await expect(who({ source: "icd10", query: "F41" }, "en", "now")).rejects.toMatchObject({
    code: "SOURCE_AUTH_FAILED",
    details: { stage: "token", upstreamStatus: 401 },
  });
});

it("classifies an invalid OAuth token response without caching it as a valid token", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const who = createWhoClient(
    fixtureFetch([{ access_token: "incomplete" }, { access_token: "incomplete" }], seen),
    { WHO_ICD_CLIENT_ID: "id", WHO_ICD_CLIENT_SECRET: "secret" },
  );
  for (let i = 0; i < 2; i++)
    await expect(who({ source: "icd10", query: "F41" }, "en", "now")).rejects.toMatchObject({
      code: "INVALID_SOURCE_RESPONSE",
      details: { stage: "token", failure: "json" },
    });
  expect(seen).toHaveLength(2);
});

it("encodes disease names in the generated Orphadata client", async () => {
  const seen: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const providers = createMedicalProviders(fixtureFetch([{ data: { results: [] } }], seen));
  await providers({ source: "orphadata", query: "A/B?lang=ru" }, "en");
  const upstream = new URL(seen[0]!.url);
  expect(upstream.pathname).toBe("/rd-cross-referencing/orphacodes/names/A%2FB%3Flang%3Dru");
  expect(upstream.searchParams.get("lang")).toBe("en");
});

it("preserves HTTP failures for non-JSON upstream errors and rejects malformed success payloads", async () => {
  for (const [status, code, downstream] of [
    [429, "SOURCE_RATE_LIMITED", 429],
    [500, "SOURCE_UNAVAILABLE", 502],
  ] as const) {
    const providers = createMedicalProviders(
      fixtureFetch([new Response("<html>private upstream details</html>", { status })]),
    );
    const response = await createMedicalHandler(providers)(
      request({ source: "ror", query: "medical" }),
      "en",
    );
    expect(response.status).toBe(downstream);
    expect(await response.json()).toEqual({ error: code, upstreamStatus: status, failure: "http" });
  }
  const providers = createMedicalProviders(
    fixtureFetch([new Response("not JSON", { status: 200 })]),
  );
  await expect(providers({ source: "ror", query: "medical" }, "en")).rejects.toMatchObject({
    code: "INVALID_SOURCE_RESPONSE",
    details: { failure: "json" },
  });
});

it("pages PubMed searches within the NCBI search window and stops at the final page", async () => {
  const calls: URL[] = [];
  const ids = Array.from({ length: 20 }, (_, index) => String(index + 21));
  const search = createMedicalProviders(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Response.json(
      url.pathname.endsWith("esearch.fcgi")
        ? { esearchresult: { count: "40", idlist: ids } }
        : {
            result: Object.fromEntries(
              ids.map((id) => [
                id,
                { title: `Publication ${id}`, pubdate: "2026", fulljournalname: "Journal" },
              ]),
            ),
          },
    );
  }, {});
  const result = await search({ source: "pubmed", query: "asthma", offset: 20 }, "en");
  expect(calls[0]!.searchParams.get("retstart")).toBe("20");
  expect(calls[0]!.searchParams.get("retmax")).toBe("20");
  expect(result.records).toHaveLength(20);
  expect(result.records[0]?.code).toBe("PMID:21");
  expect(result.truncated).toBe(false);
});
