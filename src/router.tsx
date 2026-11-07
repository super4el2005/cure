import { ConvexQueryClient } from "@convex-dev/react-query";
import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, MantineProvider, Stack } from "@mantine/core";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { createI18n } from "@/src/i18n";
import { getRequestLocale } from "@/src/lib/request-locale";
import { observeRouter } from "@/src/observability/browser";
import { reportFailure } from "@/src/observability/events";
import { createObservedCaches, retryRead } from "@/src/observability/query";
import { routeTree } from "@/src/routeTree.gen";

export function getRouter() {
  const CONVEX_URL = import.meta.env.CONVEX_URL;
  if (!CONVEX_URL) {
    throw new Error("Missing CONVEX_URL environment variable");
  }
  const convexQueryClient = new ConvexQueryClient(CONVEX_URL, { expectAuth: true });

  const queryClient: QueryClient = new QueryClient({
    ...createObservedCaches(),
    defaultOptions: {
      queries: {
        retry: retryRead,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultErrorComponent: ({ reset }) => (
      <I18nProvider i18n={createI18n(getRequestLocale())}>
        <MantineProvider>
          <Stack p="md">
            <Alert color="red">
              <Trans>
                Не удалось открыть страницу. Сохранённые данные доступны после восстановления.
              </Trans>
            </Alert>
            <Group>
              <Button
                onClick={() => {
                  reset();
                  void router.invalidate();
                }}
              >
                <Trans>Повторить</Trans>
              </Button>
              <Button variant="default" onClick={() => window.location.reload()}>
                <Trans>Перезагрузить</Trans>
              </Button>
            </Group>
          </Stack>
        </MantineProvider>
      </I18nProvider>
    ),
    defaultOnCatch: (error) => reportFailure(error, "route.render"),
    context: { queryClient, convexQueryClient, isShell: (): boolean => router.isShell() },
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  observeRouter(router);

  return router;
}
