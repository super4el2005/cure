import * as Sentry from "@sentry/tanstackstart-react";
import { MutationCache, QueryCache } from "@tanstack/react-query";

import { failureDetails, recordOperation, reportFailure } from "@/src/observability/events";
import { actions } from "@/src/observability/policy";

export function createObservedCaches() {
  const running = new WeakMap<
    object,
    { at: number; operation: string; span: ReturnType<typeof Sentry.startInactiveSpan> }
  >();
  return {
    queryCache: new QueryCache({
      onError: (error) => {
        reportFailure(error, "query.load");
        recordOperation("query.load", "error", 0, failureDetails(error).code);
      },
    }),
    mutationCache: new MutationCache({
      onMutate: (_variables, mutation) => {
        const operation = actions[String(mutation.options.mutationKey?.[0])] ?? "user.operation";
        running.set(mutation, {
          at: performance.now(),
          operation,
          span: Sentry.startInactiveSpan({
            name: operation,
            op: "ui.action",
            attributes: { "app.operation": operation },
          }),
        });
      },
      onSettled: (data, error, _variables, _context, mutation) => {
        const state = running.get(mutation);
        if (!state) return;
        const failedSave = state.operation === "catalog.persist" && data === false;
        const details = error
          ? failureDetails(error)
          : failedSave
            ? { code: "PERSISTENCE_FAILED" }
            : undefined;
        const outcome = details?.code === "CANCELLED" ? "cancelled" : details ? "error" : "success";
        state.span.setAttribute("app.outcome", outcome);
        state.span.setStatus({ code: details ? 2 : 1 });
        state.span.end();
        recordOperation(state.operation, outcome, performance.now() - state.at, details?.code);
        if (details && details.code !== "CANCELLED")
          reportFailure(error ?? new Error(details.code), state.operation, details.code);
        running.delete(mutation);
      },
    }),
  };
}
export function retryRead(failures: number, error: unknown): boolean {
  const { status, code } = failureDetails(error);
  return (
    failures < 2 &&
    code !== "CANCELLED" &&
    (code === "NETWORK_ERROR" ||
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500))
  );
}
