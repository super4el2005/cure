import * as Sentry from "@sentry/tanstackstart-react";
import axios from "axios";

import { errorCodes } from "@/src/observability/policy";

export function failureDetails(error: unknown): { code: string; status?: number } {
  if (axios.isCancel(error) || (error instanceof Error && error.name === "AbortError"))
    return { code: "CANCELLED" };
  if (axios.isAxiosError<{ error?: unknown }>(error)) {
    const code = error.response?.data?.error;
    return {
      code:
        typeof code === "string" && errorCodes.has(code)
          ? code
          : error.response
            ? "HTTP_ERROR"
            : "NETWORK_ERROR",
      ...(error.response ? { status: error.response.status } : {}),
    };
  }
  if (error instanceof Error && errorCodes.has(error.message)) return { code: error.message };
  return { code: "RUNTIME_ERROR" };
}
export function reportFailure(
  error: unknown,
  operation: string,
  code = failureDetails(error).code,
): void {
  if (code === "CANCELLED") return;
  try {
    Sentry.captureException(error, { tags: { "app.operation": operation, "app.code": code } });
  } catch {
    /* Telemetry must not affect operations. */
  }
}
export function recordOperation(
  operation: string,
  outcome: string,
  duration = 0,
  code?: string,
  requestId?: string,
): void {
  const attributes = {
    "app.operation": operation,
    "app.outcome": outcome,
    "app.duration_ms": Math.round(duration),
    ...(code ? { "app.code": code } : {}),
    ...(requestId ? { "app.request_id": requestId } : {}),
  };
  try {
    Sentry.addBreadcrumb({ category: "app.action", message: "app.operation", data: attributes });
    Sentry.logger.info("app.operation", attributes);
    const metricAttributes = {
      "app.operation": operation,
      "app.outcome": outcome,
      ...(code ? { "app.code": code } : {}),
    };
    Sentry.metrics.count("app.operations", 1, { attributes: metricAttributes });
    Sentry.metrics.distribution("app.operation.duration", duration, {
      unit: "millisecond",
      attributes: metricAttributes,
    });
  } catch {
    /* Telemetry must not affect operations. */
  }
}
// One guard for local data initialization; pages never contain logging calls.
export function openLocalData<T>(operation: string, factory: () => T): T | undefined {
  try {
    return factory();
  } catch (error) {
    reportFailure(error, operation, "STORAGE_UNAVAILABLE");
    recordOperation(operation, "error", 0, "STORAGE_UNAVAILABLE");
    return undefined;
  }
}

export async function observePromise<T>(operation: string, task: Promise<T>): Promise<T> {
  const at = performance.now();
  try {
    const result = await task;
    recordOperation(operation, "success", performance.now() - at);
    return result;
  } catch (error) {
    reportFailure(error, operation);
    recordOperation(operation, "error", performance.now() - at, failureDetails(error).code);
    throw error;
  }
}
