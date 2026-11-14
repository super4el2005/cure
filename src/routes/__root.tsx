import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import { I18nProvider } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
import {
  Anchor,
  AppShell,
  Burger,
  NavLink,
  ScrollArea,
  Textarea,
  Divider,
  Select,
  useMantineColorScheme,
  Alert,
  Button,
  ColorSchemeScript,
  Group,
  mantineHtmlProps,
  MantineProvider,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure, useNetwork, useSetState, useWindowEvent } from "@mantine/hooks";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { NavigationProgress } from "@mantine/nprogress";
import { Serwist } from "@serwist/window";
import { QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { Outlet, Scripts, HeadContent } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as React from "react";

import { createI18n } from "@/src/i18n";
import { authClient } from "@/src/lib/auth-client";

import "@mantine/notifications/styles.css";
import "@mantine/nprogress/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/dates/styles.css";

import { getToken } from "@/src/lib/auth-server";
import { signOutClinicalSession } from "@/src/lib/clinical-identity";
import { saveLanguage } from "@/src/lib/language";
import type { Locale } from "@/src/lib/locale";
import { defaultLocale, lastLocaleKey } from "@/src/lib/locale";
import { PwaInstallContext } from "@/src/lib/pwa-install";
import { getRequestDevice } from "@/src/lib/request-device";
import { getRequestLocale } from "@/src/lib/request-locale";
import { useRetainedWorkspaces } from "@/src/lib/use-retained-workspaces";
import { useShellChat } from "@/src/lib/use-shell-chat";
import { observePromise } from "@/src/observability/events";

import mantineCoreStyles from "@mantine/core/styles.css?url";

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

const getAuth = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { getSessionCookie } = await import("better-auth/cookies");
  // Anonymous pages must not depend on availability of the auth backend.
  if (!getSessionCookie(getRequestHeaders())) return undefined;
  return getToken();
});

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
  useRetainedWorkspaces();
  const { t, i18n } = useLingui();
  const { online } = useNetwork();
  const pathname = useLocation({ select: (location) => location.pathname });
  const landing = ["/", "/d", "/m"].includes(pathname);
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
        <ColorSchemeScript defaultColorScheme="auto" />
        <HeadContent />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          <ModalsProvider>
            <PwaInstallContext.Provider
              value={{
                available: Boolean(pwa.install),
                pending: install.isPending,
                install: () => install.mutate(),
              }}
            >
              <ApplicationNavigation>
                {!landing && !online && <Alert>{t`Нет сети. Доступны сохранённые данные.`}</Alert>}
                {!landing && (pwa.failed || install.isError) && (
                  <Alert color="red">{t`Не удалось подготовить офлайн-запуск.`}</Alert>
                )}
                {!landing && pwa.update && (
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => {
                      const worker = pwa.update;
                      if (!worker) return;
                      setPwa({ update: null });
                      worker.addEventListener("controlling", () => window.location.reload());
                      worker.messageSkipWaiting();
                    }}
                  >{t`Обновить приложение`}</Button>
                )}
                {children}
              </ApplicationNavigation>
            </PwaInstallContext.Provider>
          </ModalsProvider>
          <NavigationProgress />
          <Notifications />
        </MantineProvider>
        <Scripts />
      </body>
    </html>
  );
}

function ApplicationNavigation({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const base = pathname.startsWith("/m") ? "/m" : "/d";
  const [menuOpen, menu] = useDisclosure(!pathname.startsWith("/m"));
  const [chatOpen, chat] = useDisclosure(!pathname.startsWith("/m"));
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const authentication = useMutation({
    mutationKey: ["authentication"],
    retry: false,
    networkMode: "always",
    mutationFn: async (action: "sign-in" | "sign-out") => {
      if (action === "sign-in") {
        const result = await authClient.signIn.social({
          provider: "google",
          callbackURL: new URL(`${base}/workspace`, window.location.origin).href,
          errorCallbackURL: new URL("/auth/error", window.location.origin).href,
        });
        if (result.error) throw new Error("SIGN_IN_FAILED");
      } else {
        const result = await signOutClinicalSession(queryClient);
        if (result.error) throw new Error("SIGN_OUT_FAILED");
        await queryClient.cancelQueries();
        queryClient.clear();
        await router.invalidate();
      }
    },
  });
  const language = useMutation({
    mutationKey: ["language"],
    networkMode: "always",
    retry: false,
    mutationFn: async (locale: Locale) => {
      saveLanguage(locale);
      await router.invalidate();
    },
  });
  const appearance = useMutation({
    mutationKey: ["appearance"],
    networkMode: "always",
    retry: false,
    mutationFn: async (scheme: "auto" | "light" | "dark") => setColorScheme(scheme),
  });
  const { isAuthenticated } = Route.useRouteContext();
  const app =
    !["/", "/d", "/m"].includes(pathname) || Boolean(session.data?.user) || isAuthenticated;
  const mobile = base === "/m";
  const links = [
    ["workspace", t`Обзор`],
    ["patients", t`Пациенты`],
    ["projects", t`Мои исследования`],
    ["invitations", t`Приглашения`],
    ["analytics", t`Аналитика`],
    ["library", t`Библиотека`],
    ["specialists", t`Специалисты`],
    ["organizations", t`Организации`],
    ["research", t`Каталог исследований`],
    ["organization/members", t`Сотрудники и доступ`],
    ["tools", t`Справочники и AI`],
    ["profile", t`Профиль`],
  ];
  const controls = (
    <Group gap="xs" wrap="nowrap">
      <Select
        size="xs"
        w={100}
        aria-label={t`Язык интерфейса`}
        allowDeselect={false}
        value={i18n.locale}
        disabled={language.isPending}
        onChange={(locale) => {
          if (locale === "ru" || locale === "en") language.mutate(locale);
        }}
        data={[
          { value: "ru", label: "Русский" },
          { value: "en", label: "English" },
        ]}
      />
      <Select
        size="xs"
        w={130}
        aria-label={t`Тема`}
        allowDeselect={false}
        value={colorScheme}
        onChange={(scheme) => {
          if (scheme === "auto" || scheme === "light" || scheme === "dark")
            appearance.mutate(scheme);
        }}
        data={[
          { value: "auto", label: t`Авто` },
          { value: "light", label: t`Светлая` },
          { value: "dark", label: t`Тёмная` },
        ]}
      />
    </Group>
  );
  if (!app) return <>{children}</>;
  return (
    <AppShell
      padding="sm"
      header={{ height: 52 }}
      navbar={{
        width: 210,
        breakpoint: mobile ? 10000 : 0,
        collapsed: { mobile: !menuOpen, desktop: !menuOpen },
      }}
      aside={{
        width: mobile ? 290 : 320,
        breakpoint: mobile ? 10000 : 0,
        collapsed: { mobile: !chatOpen, desktop: !chatOpen },
      }}
    >
      <AppShell.Header px="sm">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Burger
              size="sm"
              opened={menuOpen}
              onClick={() => {
                menu.toggle();
                if (mobile) chat.close();
              }}
              aria-label={t`Меню`}
            />
            <Anchor component={Link} to={base} fw={700}>
              Cure
            </Anchor>
          </Group>
          {!mobile && controls}
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                chat.toggle();
                if (mobile) menu.close();
              }}
            >{t`AI-чат`}</Button>
            <Button
              size="xs"
              loading={authentication.isPending}
              onClick={() => authentication.mutate(session.data?.user ? "sign-out" : "sign-in")}
            >
              {session.data?.user ? t`Выйти` : t`Войти через Google`}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <nav aria-label={t`Основная навигация`}>
            {links.map(([path, label]) => (
              <NavLink
                key={path}
                component={Link}
                to={`${base}/${path}`}
                label={label}
                active={pathname === `${base}/${path}` || pathname.startsWith(`${base}/${path}/`)}
                onClick={() => {
                  if (mobile) menu.close();
                }}
              />
            ))}
          </nav>
        </AppShell.Section>
        {mobile && <AppShell.Section pt="xs">{controls}</AppShell.Section>}
      </AppShell.Navbar>
      <AppShell.Aside p="sm">
        <ShellChat key={session.data?.user.id ?? "anonymous"} owner={session.data?.user.id ?? ""} />
      </AppShell.Aside>
      <AppShell.Main>
        {authentication.isError && (
          <Alert color="red">{t`Вход или выход не выполнен. Проверьте соединение.`}</Alert>
        )}
        {language.isError && <Alert color="red">{t`Не удалось сменить язык.`}</Alert>}
        {children}
      </AppShell.Main>
    </AppShell>
  );
}

function ShellChat({ owner }: { owner: string }) {
  const { t } = useLingui();
  const { online } = useNetwork();
  const chat = useShellChat(owner);
  return (
    <Stack h="100%" gap="sm">
      <Group justify="space-between">
        <Text fw={600}>{t`AI-чат`}</Text>
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={chat.send.isPending}
          onClick={chat.clear}
        >{t`Очистить`}</Button>
      </Group>
      <Text size="xs" c="dimmed">
        GigaChat · {t`Не отправляйте персональные данные пациентов.`}
      </Text>
      <Divider />
      <ScrollArea flex={1} mah="100%">
        <Stack gap="xs">
          {chat.messages.length === 0 && (
            <Text
              size="sm"
              c="dimmed"
            >{t`Вопросы о работе и исследованиях. Чат пока не изменяет данные системы.`}</Text>
          )}
          {chat.messages.map((message, index) => (
            <Paper key={index} withBorder p="xs">
              <Text size="xs" fw={600}>
                {message.role === "user" ? t`Вы` : "GigaChat"}
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {message.content}
              </Text>
            </Paper>
          ))}
        </Stack>
      </ScrollArea>
      {!online && <Text size="xs">{t`AI доступен при подключении к интернету.`}</Text>}
      {!owner && <Text size="xs">{t`Войдите, чтобы использовать чат.`}</Text>}
      {chat.send.isError && (
        <Alert color="red">{t`Ответ не получен. Текст сохранён в поле — можно повторить.`}</Alert>
      )}
      <form onSubmit={chat.form.onSubmit(({ message }) => chat.send.mutate(message))}>
        <Stack gap="xs">
          <Textarea
            aria-label={t`Сообщение AI`}
            placeholder={t`Ваш вопрос`}
            minRows={2}
            maxRows={5}
            autosize
            maxLength={8000}
            disabled={chat.send.isPending}
            {...chat.form.getInputProps("message")}
          />
          <Button
            size="xs"
            type="submit"
            loading={chat.send.isPending}
            disabled={
              !online || !owner || !chat.form.values.message.trim() || chat.messages.length >= 30
            }
          >{t`Отправить`}</Button>
        </Stack>
      </form>
    </Stack>
  );
}
