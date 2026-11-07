import "@tanstack/react-start/server-only";
import {
  ClientError,
  Configuration,
  ClientSecretBasic,
  clientCredentialsGrant,
  customFetch,
  ResponseBodyError,
  WWWAuthenticateChallengeError,
} from "openid-client";

import type { Locale } from "@/src/lib/locale";
import type { MedicalRecord, MedicalSearch } from "@/src/lib/medical-catalog";
import { getICD10Entity, searchLinearization } from "@/src/server/medical/generated/who";
import { MedicalApiError, object, plainText, rows, safeUrl, text } from "@/src/server/medical/http";

export function createWhoClient(
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
) {
  let token: Awaited<ReturnType<typeof clientCredentialsGrant>> | undefined;
  let refreshing: Promise<string> | undefined;
  async function accessToken() {
    if (token && (token.expiresIn() ?? 0) > 60) return token.access_token;
    const clientId = env.WHO_ICD_CLIENT_ID?.trim();
    const secret = env.WHO_ICD_CLIENT_SECRET?.trim();
    if (!clientId || !secret) throw new MedicalApiError("SOURCE_NOT_CONFIGURED", 503);
    refreshing ??= (async () => {
      const config = new Configuration(
        {
          issuer: "https://icdaccessmanagement.who.int",
          token_endpoint: "https://icdaccessmanagement.who.int/connect/token",
        },
        clientId,
        undefined,
        ClientSecretBasic(secret),
      );
      config[customFetch] = fetchImpl as NonNullable<Configuration[typeof customFetch]>;
      config.timeout = 15;
      try {
        const data = await clientCredentialsGrant(config, { scope: "icdapi_access" });
        if ((data.expiresIn() ?? 0) <= 0) throw new MedicalApiError("INVALID_SOURCE_RESPONSE");
        token = data;
        return data.access_token;
      } catch (error) {
        if (error instanceof MedicalApiError) throw error;
        const status =
          error instanceof ResponseBodyError || error instanceof WWWAuthenticateChallengeError
            ? error.status
            : error instanceof ClientError && error.cause instanceof Response
              ? error.cause.status
              : undefined;
        if (status && status >= 400)
          throw new MedicalApiError(
            status === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNAVAILABLE",
            status === 429 ? 429 : 502,
            { upstreamStatus: status, failure: "http" },
          );
        if (
          error instanceof ClientError &&
          ["OAUTH_INVALID_RESPONSE", "OAUTH_RESPONSE_IS_NOT_JSON"].includes(error.code ?? "")
        )
          throw new MedicalApiError("INVALID_SOURCE_RESPONSE", 502, { failure: "json" });
        throw new MedicalApiError("SOURCE_UNAVAILABLE", 502, {
          failure:
            error instanceof ClientError && error.code === "OAUTH_TIMEOUT" ? "timeout" : "network",
        });
      }
    })()
      .catch((error: unknown) => {
        throw whoError(error, "token");
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }
  return async (
    input: MedicalSearch,
    locale: Locale,
    stamp: string,
  ): Promise<{ records: MedicalRecord[]; total: number | null; language: string }> => {
    const isTen = input.source === "icd10";
    const language = isTen ? "en" : locale;
    const release = isTen ? "2019" : "2026-01";
    if (isTen && !/^[a-z]\d{2}(?:\.[a-z0-9]{1,4})?$/i.test(input.query))
      throw new MedicalApiError("INVALID_SEARCH", 400);
    const lookup = async (bearer: string) => {
      const options = {
        headers: {
          Authorization: `Bearer ${bearer}`,
          "API-Version": "v2",
          "Accept-Language": language,
          Accept: "application/json",
        },
        env: { fetch: fetchImpl },
        validateStatus: (status: number) =>
          (status >= 200 && status < 300) || (isTen && status === 404),
      };
      return object(
        isTen
          ? await getICD10Entity(release, input.query.toUpperCase(), options)
          : await searchLinearization(
              release,
              "mms",
              { q: input.query, useFlexisearch: true, flatResults: true },
              options,
            ),
      );
    };
    const bearer = await accessToken();
    let data;
    try {
      data = await lookup(bearer);
    } catch (error) {
      if (!(error instanceof MedicalApiError) || error.details.upstreamStatus !== 401)
        throw whoError(error, "lookup");
      // The upstream may revoke a token before its advertised expiry. Refresh once,
      // without invalidating a newer token obtained by a concurrent request.
      if (token?.access_token === bearer) token = undefined;
      const renewed = await accessToken();
      try {
        data = await lookup(renewed);
      } catch (retryError) {
        throw whoError(retryError, "lookup");
      }
    }
    const items = isTen ? (Object.keys(data).length ? [data] : []) : rows(data.destinationEntities);
    const records = items.slice(0, 20).map((entity) => {
      const title =
        isTen && typeof entity.title === "object" ? object(entity.title)["@value"] : entity.title;
      const sourceId =
        text(entity.id) ||
        text(entity["@id"]) ||
        `https://id.who.int/icd/release/10/${release}/${input.query.toUpperCase()}`;
      return {
        id: `${input.source}:${release}:${sourceId}:${language}`,
        source: input.source,
        sourceId,
        title: plainText(title),
        code: text(entity.theCode) || text(entity.code) || (isTen ? input.query.toUpperCase() : ""),
        description: "",
        url: safeUrl(sourceId),
        dataLanguage: language,
        version: release,
        fetchedAt: stamp,
        country: "",
        latitude: null,
        longitude: null,
      };
    });
    return {
      records,
      total: isTen
        ? items.length
        : typeof data.resultChopped === "boolean" && data.resultChopped
          ? null
          : items.length,
      language,
    };
  };
}

function whoError(error: unknown, stage: "token" | "lookup") {
  if (!(error instanceof MedicalApiError))
    return new MedicalApiError("SOURCE_UNAVAILABLE", 502, { stage });
  const upstreamStatus = error.details.upstreamStatus;
  const authFailed =
    upstreamStatus === 401 ||
    upstreamStatus === 403 ||
    (stage === "token" && upstreamStatus === 400);
  return new MedicalApiError(
    authFailed ? "SOURCE_AUTH_FAILED" : error.code,
    authFailed ? 503 : error.status,
    { ...error.details, stage },
  );
}
