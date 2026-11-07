import "@tanstack/react-start/server-only";
import * as Sentry from "@sentry/tanstackstart-react";

import { recordOperation, reportFailure } from "@/src/observability/events";
import { errorCodes, safePath, telemetryOptions } from "@/src/observability/policy";

const dsn = process.env.SENTRY_DSN || process.env.PUBLIC_SENTRY_DSN;
if (dsn) {
  try {
    Sentry.init({
      ...telemetryOptions(),
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA,
      tracesSampleRate: 0.2,
      tracePropagationTargets: [],
      includeServerName: false,
    });
  } catch {
    /* Application operation does not depend on telemetry availability. */
  }
}

export async function observeRequest(
  request: Request,
  execute: () => Promise<Response> | Response,
): Promise<Response> {
  return Sentry.withIsolationScope(async () => {
    const at = performance.now();
    const operation = `${request.method} ${safePath(request.url)}`;
    const requestId = crypto.randomUUID();
    Sentry.getIsolationScope().setTag("app.request_id", requestId);
    try {
      const response = await execute();
      let code: string | undefined;
      if (
        response.status >= 400 &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        try {
          const body = await response.clone().json();
          if (typeof body?.error === "string" && errorCodes.has(body.error)) code = body.error;
        } catch {
          /* Non-JSON/truncated failures retain their HTTP status. */
        }
      }
      const failed = response.status >= 500;
      recordOperation(
        operation,
        failed ? "error" : response.status >= 400 ? "rejected" : "success",
        performance.now() - at,
        code,
        requestId,
      );
      if (failed) reportFailure(new Error(code ?? "HTTP_ERROR"), operation, code ?? "HTTP_ERROR");
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      headers.set("Cache-Control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      reportFailure(error, operation);
      recordOperation(operation, "error", performance.now() - at, "RUNTIME_ERROR", requestId);
      return Response.json(
        { error: "INTERNAL_ERROR", requestId },
        {
          status: 500,
          headers: { "Cache-Control": "private, no-store", "X-Request-Id": requestId },
        },
      );
    } finally {
      // Await the SDK's bounded flush before a serverless invocation is frozen.
      if (Sentry.getClient()) await Sentry.flush(2000).catch(() => false);
    }
  });
}
