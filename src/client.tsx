import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, MantineProvider, Stack } from "@mantine/core";
import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { startTransition, StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { createI18n } from "@/src/i18n";
import { isLocale } from "@/src/lib/locale";
import { initializeBrowser } from "@/src/observability/browser";

initializeBrowser();
const handleReactError = (error: unknown, info: { componentStack?: string | undefined }) =>
  Sentry.reactErrorHandler()(error, { componentStack: info.componentStack ?? null });
const rootOptions = { onUncaughtError: handleReactError, onRecoverableError: handleReactError };

startTransition(() => {
  const app = (
    <StrictMode>
      <Sentry.ErrorBoundary
        fallback={() => (
          <html lang={document.documentElement.lang}>
            <head />
            <body>
              <I18nProvider
                i18n={createI18n(
                  isLocale(document.documentElement.lang) ? document.documentElement.lang : "ru",
                )}
              >
                <MantineProvider>
                  <Stack p="md">
                    <Alert color="red">
                      <Trans>Произошла ошибка приложения. Перезагрузите страницу.</Trans>
                    </Alert>
                    <Button onClick={() => window.location.reload()}>
                      <Trans>Перезагрузить</Trans>
                    </Button>
                  </Stack>
                </MantineProvider>
              </I18nProvider>
            </body>
          </html>
        )}
      >
        <StartClient />
      </Sentry.ErrorBoundary>
    </StrictMode>
  );
  if (document.documentElement.dataset.offlineShell === "true") {
    // The generic offline shell can be served for a different URL and locale.
    // Render it on the client rather than hydrating unrelated static markup.
    createRoot(document, rootOptions).render(app);
  } else {
    hydrateRoot(document, app, rootOptions);
  }
});
