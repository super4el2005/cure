import { describe, expect, it } from "@rstest/core";
import type { ErrorEvent, StreamedSpanJSON } from "@sentry/core";
import { QueryClient } from "@tanstack/react-query";
import { AxiosError, CanceledError } from "axios";

import { openLocalData } from "@/src/observability/events";
import {
  safeAttributes,
  safePath,
  scrubBreadcrumb,
  scrubError,
  scrubLog,
  scrubSpan,
} from "@/src/observability/policy";
import { createObservedCaches, retryRead } from "@/src/observability/query";

describe("central observability privacy", () => {
  it("redacts medical search, auth tokens and unknown URL paths", () => {
    expect(safePath("https://host/api/medical/search?query=SECRET")).toBe("/api/medical/search");
    expect(safePath("/api/auth/callback/google?code=SECRET")).toBe("/api/auth/:action");
    expect(safePath("/patients/SECRET")).toBe("/:redacted");
    expect(
      safeAttributes({
        "app.code": "SECRET",
        "app.operation": "SECRET",
        "http.request.body": "SECRET",
        "app.outcome": "success",
      }),
    ).toEqual({ "app.outcome": "success" });
  });
  it("removes error data but preserves frame positions and known error codes", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "SECRET",
      user: { email: "SECRET" },
      extra: { body: "SECRET" },
      request: { url: "https://host?SECRET", data: "SECRET" },
      contexts: { custom: { prompt: "SECRET" } },
      tags: { "app.code": "AI_UNAVAILABLE", diagnosis: "SECRET" },
      breadcrumbs: [{ category: "console", message: "SECRET" }],
      exception: {
        values: [
          {
            type: "Error",
            value: "SECRET",
            stacktrace: {
              frames: [
                {
                  filename: "/assets/app.js?SECRET",
                  lineno: 42,
                  vars: { key: "SECRET" },
                  context_line: "SECRET",
                },
              ],
            },
          },
        ],
      },
    };
    const result = scrubError(event);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result.exception?.values?.[0]?.value).toBe("AI_UNAVAILABLE");
    expect(result.exception?.values?.[0]?.stacktrace?.frames?.[0]?.lineno).toBe(42);
  });
  it("drops console/DOM logs and sanitizes automatic spans", () => {
    expect(scrubBreadcrumb({ category: "ui.click", message: "SECRET" })).toBeNull();
    expect(scrubLog({ level: "info", message: "SECRET" })).toBeNull();
    const span: StreamedSpanJSON = {
      status: "ok",
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      name: "POST https://host/api/medical/search?query=SECRET",
      start_timestamp: 1,
      is_segment: false,
      attributes: { "http.request.body": "SECRET", "app.code": "SOURCE_UNAVAILABLE" },
    };
    expect(JSON.stringify(scrubSpan(span))).not.toContain("SECRET");
    expect(scrubSpan(span).name).toBe("/api/medical/search");
  });
});

describe("operation resilience", () => {
  it("does not convert local storage failures into an application crash", () => {
    expect(
      openLocalData("storage.catalog", () => {
        throw new Error("blocked storage");
      }),
    ).toBeUndefined();
  });
  it("retries only bounded transient reads", () => {
    expect(retryRead(0, new AxiosError("network", "ERR_NETWORK"))).toBe(true);
    expect(retryRead(2, new AxiosError("network", "ERR_NETWORK"))).toBe(false);
    expect(retryRead(0, new CanceledError())).toBe(false);
    expect(retryRead(0, new Error("UNAUTHENTICATED"))).toBe(false);
  });
  it("observes both failed persistence and successful mutations without changing results", async () => {
    const client = new QueryClient({ ...createObservedCaches() });
    const mutation = client
      .getMutationCache()
      .build(client, { mutationKey: ["save-medical-records"], mutationFn: async () => false });
    expect(await mutation.execute(undefined)).toBe(false);
    expect(mutation.state.status).toBe("success");
    const failure = client.getMutationCache().build(client, {
      mutationKey: ["authentication"],
      mutationFn: async () => {
        throw new Error("SIGN_IN_FAILED");
      },
    });
    await expect(failure.execute(undefined)).rejects.toThrow("SIGN_IN_FAILED");
    client.clear();
  });
});

it("identifies clinical and project routes without recording record IDs or query data", () => {
  expect(safePath("https://cure.test/d/patients/private-patient/consents?diagnosis=F41")).toBe(
    "/d/patients/:id/consents",
  );
  expect(safePath("https://cure.test/m/projects/private-study/work")).toBe("/m/projects/:id/work");
  expect(safePath("https://cure.test/d/patients/private-patient/secret-notes")).toBe("/:redacted");
});

it("observes library and research actions without exposing record identifiers or private notes", () => {
  expect(safePath("/d/library")).toBe("/d/library");
  for (const operation of ["clinical.sync", "forms.sync", "projects.queue"])
    expect(safeAttributes({ "app.operation": operation, notes: "SECRET" })).toEqual({
      "app.operation": operation,
    });
  expect(
    safeAttributes({
      "app.operation": "library.sync",
      "app.code": "REVISION_CONFLICT",
      notes: "SECRET",
    }),
  ).toEqual({ "app.operation": "library.sync", "app.code": "REVISION_CONFLICT" });
  expect(safePath("/m/projects/private-study/credits")).toBe("/m/projects/:id/credits");
  expect(safePath("/d/projects/private-study/safety")).toBe("/d/projects/:id/safety");
  expect(safePath("/m/projects/private-study/visits")).toBe("/m/projects/:id/visits");
  expect(safePath("/d/patients/private-patient/enrollment")).toBe("/d/patients/:id/enrollment");
  expect(
    safeAttributes({
      "app.operation": "library.save",
      "app.code": "INVALID_LIBRARY",
      "private.notes": "SECRET",
      "app.outcome": "error",
    }),
  ).toEqual({
    "app.operation": "library.save",
    "app.code": "INVALID_LIBRARY",
    "app.outcome": "error",
  });
});
