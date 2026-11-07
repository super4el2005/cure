import "@tanstack/react-start/server-only";
import { LRUCache } from "lru-cache";

import { medicalSearchSchema } from "@/src/lib/contracts";
import type { Locale } from "@/src/lib/locale";
import type { MedicalSearch } from "@/src/lib/medical-catalog";
import { MedicalApiError } from "@/src/server/medical/http";
import { createMedicalProviders } from "@/src/server/medical/providers";

export function createMedicalHandler(search = createMedicalProviders()) {
  const cache = new LRUCache<
    string,
    Awaited<ReturnType<typeof search>>,
    { input: MedicalSearch; locale: Locale }
  >({
    max: 100,
    ttl: 60_000,
    fetchMethod: (_key, _previous, { context }) => search(context.input, context.locale),
  });
  return async (request: Request, locale: Locale) => {
    const respond = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return respond({ error: "FORBIDDEN_ORIGIN" }, 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return respond({ error: "INVALID_REQUEST" }, 415);
    try {
      const content = await request.text();
      if (content.length > 2048) return respond({ error: "INVALID_SEARCH" }, 400);
      const parsed = medicalSearchSchema.safeParse(JSON.parse(content));
      if (!parsed.success) return respond({ error: "INVALID_SEARCH" }, 400);
      const input = parsed.data;
      return respond(
        await cache.fetch(JSON.stringify([input, locale]), { context: { input, locale } }),
      );
    } catch (error) {
      if (error instanceof MedicalApiError)
        return respond({ error: error.code, ...error.details }, error.status);
      if (error instanceof SyntaxError) return respond({ error: "INVALID_SEARCH" }, 400);
      return respond({ error: "SOURCE_UNAVAILABLE" }, 502);
    }
  };
}
export const handleMedicalSearch = createMedicalHandler();
