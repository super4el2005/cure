import "@tanstack/react-start/server-only";
import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import { compile } from "html-to-text";
import { z } from "zod";

export class MedicalApiError extends Error {
  constructor(
    public readonly code:
      | "SOURCE_NOT_CONFIGURED"
      | "SOURCE_AUTH_FAILED"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_RATE_LIMITED"
      | "INVALID_SEARCH"
      | "INVALID_SOURCE_RESPONSE",
    public readonly status = 502,
    public readonly details: {
      stage?: "token" | "lookup";
      upstreamStatus?: number;
      failure?: "http" | "network" | "timeout" | "json";
    } = {},
  ) {
    super(code);
  }
}
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new MedicalApiError("INVALID_SOURCE_RESPONSE", 502, { failure: "json" });
  return parsed.data;
}
export function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
const htmlToText = compile({
  wordwrap: false,
  selectors: [{ selector: "a", options: { ignoreHref: true } }],
});
export function plainText(value: unknown): string {
  return htmlToText(text(value));
}
export function safeUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
const client = axios.create({
  adapter: "fetch",
  timeout: 15_000,
  maxRedirects: 0,
  responseType: "json",
  transitional: { silentJSONParsing: true, clarifyTimeoutError: true },
  fetchOptions: { redirect: "error" },
});
export async function medicalRequest<T>(
  config: AxiosRequestConfig,
  options?: AxiosRequestConfig,
): Promise<T> {
  try {
    const response = await client.request<T>({ ...config, ...options });
    return (response.status === 404 ? {} : object(response.data)) as T;
  } catch (error) {
    if (error instanceof MedicalApiError) throw error;
    if (!axios.isAxiosError(error))
      throw new MedicalApiError("INVALID_SOURCE_RESPONSE", 502, { failure: "json" });
    if (error.code === "ERR_BAD_RESPONSE" && !error.response)
      throw new MedicalApiError("INVALID_SOURCE_RESPONSE", 502, { failure: "json" });
    const upstreamStatus = error.response?.status;
    throw new MedicalApiError(
      upstreamStatus === 429 ? "SOURCE_RATE_LIMITED" : "SOURCE_UNAVAILABLE",
      upstreamStatus === 429 ? 429 : 502,
      upstreamStatus
        ? { upstreamStatus, failure: "http" }
        : {
            failure: ["ETIMEDOUT", "ECONNABORTED", "ERR_CANCELED"].includes(error.code ?? "")
              ? "timeout"
              : "network",
          },
    );
  }
}
export async function jsonFetch(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<Json> {
  const data = await medicalRequest<unknown>({
    url: String(url),
    method: init.method ?? "GET",
    data: init.body,
    headers: Object.fromEntries(new Headers(init.headers)),
    ...(init.signal ? { signal: init.signal } : {}),
    env: { fetch: fetchImpl },
    validateStatus: (status) =>
      (status >= 200 && status < 300) || (allowNotFound && status === 404),
  });
  return data === "" && allowNotFound ? {} : object(data);
}
