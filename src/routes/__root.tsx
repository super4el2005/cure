import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { I18nProvider } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Button,
  ColorSchemeScript,
  Container,
  Group,
  mantineHtmlProps,
  MantineProvider,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useNetwork, useSetState, useWindowEvent } from "@mantine/hooks";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { NavigationProgress } from "@mantine/nprogress";
import { Serwist } from "@serwist/window";
import { QueryClient, useMutation } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { Outlet, Scripts, HeadContent } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import "@mantine/notifications/styles.css";
import "@mantine/nprogress/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/dates/styles.css";

import * as React from "react";

import { createI18n } from "@/src/i18n";
import { authClient } from "@/src/lib/auth-client";
import { getToken } from "@/src/lib/auth-server";
import { defaultLocale, lastLocaleKey } from "@/src/lib/locale";
import { getRequestDevice } from "@/src/lib/request-device";
import { getRequestLocale } from "@/src/lib/request-locale";
import { observePromise } from "@/src/observability/events";

import mantineCoreStyles from "@mantine/core/styles.css?url";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

const getAuth = createServerFn({ method: "GET" }).handler(async () => getToken());

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
  isShell: () => boolean;
}>()({
  beforeLoad: async ({ context }) => {
    // Client authentication is managed by Better Auth. A prerendered shell
    // contains no user tokens and must not require a live auth backend.
    if (typeof window !== "undefined" || context.isShell()) {
      return { token: undefined, isAuthenticated: false };
    }
    const token = await getAuth();
    const httpClient = context.convexQueryClient.serverHttpClient;
    if (token) httpClient?.setAuth(token);
    else httpClient?.clearAuth();

    return { token, isAuthenticated: Boolean(token) };
  },
  // The build-time shell transports root loader data too. Give its client
  // bootstrap a different match identity so locale/device are resolved locally
  // even when opening the exact same URL that was prerendered.
  loaderDeps: () => ({
    fromOfflineShell:
      typeof document !== "undefined" && document.documentElement.dataset.offlineShell === "true",
  }),
  loader: ({ context }) => ({
    locale: typeof window === "undefined" && context.isShell() ? defaultLocale : getRequestLocale(),
    device: typeof window === "undefined" && context.isShell() ? undefined : getRequestDevice(),
  }),
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Cure",
      },
      { name: "theme-color", content: "#0f766e" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Cure" },
    ],
    links: [
      { rel: "stylesheet", href: mantineCoreStyles },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  // Start serializes loader data for hydration, so both environments use
  // the same locale without relying on browser-only language detection.
  const { locale } = Route.useLoaderData();
  const i18n = React.useMemo(() => createI18n(locale), [locale]);
  React.useEffect(() => {
    try {
      localStorage.setItem(lastLocaleKey, locale);
    } catch {
      // A blocked store must not prevent rendering or navigation.
    }
  }, [locale]);
  const { token, convexQueryClient } = Route.useRouteContext();

  return (
    <ConvexBetterAuthProvider
      client={convexQueryClient.convexClient}
      authClient={authClient}
      initialToken={token ?? null}
    >
      <I18nProvider i18n={i18n}>
        <RootDocument>
          <Outlet />
        </RootDocument>
      </I18nProvider>
    </ConvexBetterAuthProvider>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useLingui();
  const { online } = useNetwork();
  const [pwa, setPwa] = useSetState<{
    install: InstallPrompt | null;
    update: Serwist | null;
    ready: boolean;
    failed: boolean;
  }>({ install: null, update: null, ready: false, failed: false });
  useWindowEvent("beforeinstallprompt", (event) => {
    event.preventDefault();
    if ("prompt" in event && typeof event.prompt === "function") {
      setPwa({ install: event as unknown as InstallPrompt });
    }
  });
  useWindowEvent("appinstalled", () => setPwa({ install: null }));
  // Serwist owns worker registration and lifecycle; window events use Mantine.
  React.useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let disposed = false;
    const worker = new Serwist("/sw.js", { scope: "/" });
    worker.addEventListener("waiting", () => {
      if (!disposed) setPwa({ update: worker });
    });
    worker.addEventListener("controlling", () => {
      if (!disposed) setPwa({ ready: true });
    });
    void observePromise("pwa.register", worker.register())
      .then(async () => {
        await navigator.serviceWorker.ready;
        if (!disposed) setPwa({ ready: true });
      })
      .catch(() => {
        if (!disposed) setPwa({ failed: true });
      });
    return () => {
      disposed = true;
    };
  }, [setPwa]);
  const install = useMutation({
    mutationKey: ["install-pwa"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      try {
        await pwa.install?.prompt();
      } finally {
        setPwa({ install: null });
      }
    },
  });
  const { isShell } = Route.useRouteContext();
  const { device } = Route.useLoaderData();

  return (
    <html
      lang={i18n.locale}
      data-device={device}
      data-offline-shell={isShell() ? "true" : undefined}
      {...mantineHtmlProps}
    >
      <head>
        <ColorSchemeScript />
        <HeadContent />
      </head>
      <body>
        <MantineProvider>
          <ModalsProvider>
            <Container py="md">
              <Paper component="aside" aria-label={t`Приложение`}>
                <Stack>
                  {!online && (
                    <Text role="status">{t`Нет интернета. Доступны сохранённые на устройстве данные.`}</Text>
                  )}
                  {pwa.ready && (
                    <Text role="status">{t`Приложение готово к запуску без интернета.`}</Text>
                  )}
                  {(pwa.failed || install.isError) && (
                    <Alert role="alert">{t`Не удалось подготовить приложение для работы без интернета.`}</Alert>
                  )}
                  <Group>
                    {pwa.install && (
                      <Button
                        loading={install.isPending}
                        onClick={() => install.mutate()}
                      >{t`Установить приложение`}</Button>
                    )}
                    {pwa.update && (
                      <Button
                        onClick={() => {
                          const worker = pwa.update;
                          if (!worker) return;
                          setPwa({ update: null });
                          worker.addEventListener("controlling", () => window.location.reload());
                          worker.messageSkipWaiting();
                        }}
                      >{t`Обновить приложение`}</Button>
                    )}
                  </Group>
                </Stack>
              </Paper>
            </Container>
            {children}
          </ModalsProvider>
          <NavigationProgress />
          <Notifications />
        </MantineProvider>
        <Scripts />
      </body>
    </html>
  );
}
