import { makeBrowserOfflineTransport, makeFetchTransport } from "@sentry/browser";
import * as Sentry from "@sentry/tanstackstart-react";
import type { AnyRouter } from "@tanstack/react-router";

import { recordOperation } from "@/src/observability/events";
import { safePath, telemetryOptions } from "@/src/observability/policy";

let initialized = false;
export function initializeBrowser(): void {
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  const dsn = import.meta.env.PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      ...telemetryOptions(),
      dsn,
      environment: import.meta.env.PUBLIC_SENTRY_ENVIRONMENT || "development",
      release: import.meta.env.PUBLIC_SENTRY_RELEASE,
      tracesSampleRate: 0.2,
      tracePropagationTargets: [/^\/api\//, /^\/_serverFn\//],
      transport: (options: Parameters<typeof makeFetchTransport>[0]) =>
        makeBrowserOfflineTransport(makeFetchTransport)({
          ...options,
          dbName: "cure-observability",
          maxQueueSize: 30,
          flushAtStartup: true,
        }),
    });
  } catch {
    /* Monitoring initialization must never prevent application startup. */
  }
}
export function observeRouter(router: AnyRouter): void {
  if (typeof window === "undefined") return;
  initializeBrowser();
  if (Sentry.getClient())
    Sentry.addIntegration(Sentry.tanstackRouterBrowserTracingIntegration(router));
  router.subscribe("onResolved", ({ toLocation }) =>
    recordOperation(`navigation${safePath(toLocation.pathname)}`, "success"),
  );
}
