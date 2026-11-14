import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Container,
  Fieldset,
  Group,
  List,
  Select,
  NumberInput,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useMounted, useNetwork } from "@mantine/hooks";
import { useByok } from "@tanstack/ai-react";
import { defineByok, memoryStorage } from "@tanstack/ai-react/byok";
import { deepEquals } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import axios from "axios";
import { useEffect, useMemo, useRef } from "react";

import { aiProviders, byokProviders, isAiProvider } from "@/src/lib/ai-providers";
import { authClient } from "@/src/lib/auth-client";
import {
  aiResponseSchema,
  medicalFormSchema,
  medicalResultSchema,
  medicalSearchSchema,
} from "@/src/lib/contracts";
import { aiDefaults, createAiPreferences } from "@/src/lib/device-data";
import type { AiPreferences } from "@/src/lib/device-data";
import { checkAi, useSearchMedical } from "@/src/lib/generated/cure";
import { createMedicalCache, saveMedicalRecords } from "@/src/lib/medical-cache";
import {
  medicalSearchRequest,
  filterMedicalRecords,
  isMedicalSource,
  medicalAttribution,
} from "@/src/lib/medical-catalog";
import type { MedicalResult, MedicalSource } from "@/src/lib/medical-catalog";
import { openLocalData } from "@/src/observability/events";

export const Route = createFileRoute("/d_/tools")({ component: DesktopHome });

function DesktopHome() {
  const { t } = useLingui();
  const mounted = useMounted();
  const { online } = useNetwork();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const byok = useMemo(
    () => defineByok({ storage: memoryStorage(), providers: byokProviders }),
    [userId],
  );
  const keys = useByok(byok);
  const request = useRef<AbortController | null>(null);
  const keyForm = useForm({ initialValues: { key: "" } });

  // Explicit storage avoids silently treating an in-memory fallback as durable.
  const catalog = useMemo(() => {
    if (!mounted) return undefined;
    return openLocalData("storage.catalog", () => createMedicalCache(window.localStorage));
  }, [mounted]);
  const preferencesCollection = useMemo(() => {
    if (!mounted || !userId) return undefined;
    return openLocalData("storage.preferences", () =>
      createAiPreferences(userId, window.localStorage),
    );
  }, [mounted, userId]);
  const { data: catalogRows } = useLiveQuery(() => catalog);
  const { data: preferenceRows } = useLiveQuery(() => preferencesCollection);
  const preferences = preferenceRows?.find((row) => row.id === "preferences") ?? aiDefaults;
  const hasKey = keys.status[preferences.provider]?.state === "set";

  // Account-bound secret and request lifecycle; neither belongs in persistent DB.
  useEffect(() => {
    keyForm.reset();
    return () => {
      request.current?.abort();
      void byok.clear();
    };
  }, [byok, keyForm.reset]);

  const savePreferences = useMutation({
    mutationKey: ["ai-preferences", userId],
    networkMode: "always",
    retry: false,
    mutationFn: async ({ owner, patch }: { owner: string; patch: Partial<AiPreferences> }) => {
      if (!preferencesCollection || owner !== userId) throw new Error("STORAGE_UNAVAILABLE");
      await preferencesCollection.toArrayWhenReady();
      const transaction = preferencesCollection.get("preferences")
        ? preferencesCollection.update("preferences", (draft) => {
            Object.assign(draft, patch);
          })
        : preferencesCollection.insert({ ...aiDefaults, ...patch });
      await transaction.when("settled");
    },
  });
  const keyAction = useMutation({
    mutationKey: ["ai-key", userId],
    networkMode: "always",
    retry: false,
    mutationFn: async ({ owner, action }: { owner: string; action: "save" | "clear" }) => {
      if (owner !== userId) throw new Error("ACCOUNT_CHANGED");
      if (action === "clear") await byok.clear(preferences.provider);
      else await byok.update(preferences.provider, keyForm.values.key.trim());
    },
    onSuccess: () => keyForm.reset(),
  });
  const check = useMutation({
    mutationKey: ["ai-connection-check", userId],
    networkMode: "always",
    retry: false,
    mutationFn: async (owner: string) => {
      if (owner !== userId) throw new Error("ACCOUNT_CHANGED");
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      aiResponseSchema.parse(
        await checkAi(
          {
            ...preferences,
            messages: [{ role: "user", content: "Reply with OK." }],
          },
          {
            signal: controller.signal,
            headers: preferences.provider === "gigachat" ? {} : byok.headers(preferences.provider),
          },
        ),
      );
      return true;
    },
  });
  const checkError = axios.isAxiosError<{ error: string }>(check.error)
    ? check.error.response?.data?.error
    : undefined;
  const checkErrorText =
    checkError === "AI_NOT_CONFIGURED"
      ? t`Нейросеть не настроена. Проверьте ключ и серверные настройки провайдера.`
      : checkError === "AUTH_UNAVAILABLE" || checkError === "UNAUTHENTICATED"
        ? t`Не удалось подтвердить вход. Проверьте подключение и войдите снова.`
        : checkError === "AI_TLS_ERROR"
          ? t`Сервер не смог проверить сертификат нейросети.`
          : checkError === "AI_PROVIDER_UNAUTHORIZED"
            ? t`Провайдер отклонил ключ или доступ к модели.`
            : checkError === "AI_RATE_LIMITED"
              ? t`Достигнут лимит провайдера. Повторите запрос позже.`
              : checkError === "AI_TIMEOUT"
                ? t`Нейросеть не ответила вовремя. Повторите запрос позже.`
                : t`Не удалось проверить подключение. Проверьте ключ, модель и настройки API.`;

  const catalogForm = useForm<{
    source: MedicalSource;
    query: string;
    latitude: number | string;
    longitude: number | string;
    radius: number | string;
  }>({
    initialValues: { source: "ror", query: "", latitude: "", longitude: "", radius: 5000 },
    validate: schemaResolver(medicalFormSchema, { sync: true }),
  });
  const { source, query } = catalogForm.values;
  const sourceLabels: Record<MedicalSource, string> = {
    ror: t`Университеты — ROR`,
    osm: t`Больницы и клиники — OpenStreetMap`,
    geofabrik: t`Региональные выгрузки — Geofabrik`,
    icd11: t`МКБ-11 — ВОЗ`,
    icd10: t`МКБ-10 — ВОЗ (по коду)`,
    pubmed: t`Публикации — PubMed`,
    orphadata: t`Редкие заболевания — Orphadata`,
  };
  const saveDownloaded = useMutation({
    mutationKey: ["save-medical-records"],
    networkMode: "always",
    retry: false,
    mutationFn: async (result: MedicalResult) =>
      catalog
        ? saveMedicalRecords(catalog, result.records).then(
            () => true,
            () => false,
          )
        : false,
  });
  const search = useSearchMedical({
    mutation: {
      networkMode: "always",
      retry: false,
      onMutate: () => saveDownloaded.reset(),
      onSuccess: async (result) => {
        await saveDownloaded.mutateAsync(medicalResultSchema.parse(result));
      },
    },
  });
  const searchError = axios.isAxiosError<{ error: string }>(search.error)
    ? search.error.response?.data?.error
    : undefined;
  const parsedInput = medicalFormSchema.safeParse(catalogForm.values).data;
  const currentInput = parsedInput ? medicalSearchRequest(parsedInput) : undefined;
  const matchesSearch = deepEquals(search.variables?.data, currentInput);
  const resultIds = new Set(matchesSearch ? search.data?.records.map((record) => record.id) : []);
  const savedRecords =
    matchesSearch && search.data
      ? (catalogRows ?? []).filter((record) => resultIds.has(record.id))
      : filterMedicalRecords(
          catalogRows ?? [],
          source,
          query,
          currentInput?.source === "osm" ? currentInput : undefined,
        ).slice(0, 100);
  const visible =
    matchesSearch && search.data && !saveDownloaded.data ? search.data.records : savedRecords;
  const attribution = medicalAttribution[source];

  return (
    <Container component="main" data-page="desktop" py="sm">
      <Stack gap="sm">
        <Title order={1}>{t`Справочники и AI`}</Title>
        <Paper component="section" aria-label={t`Настройки AI`} withBorder p="sm">
          <Stack gap="sm">
            <Title order={2}>{t`Нейросеть`}</Title>
            {!mounted || !userId ? (
              <Text>{t`Войдите, чтобы настроить нейросеть.`}</Text>
            ) : !preferencesCollection ? (
              <Alert role="alert">{t`Не удалось открыть настройки AI на устройстве.`}</Alert>
            ) : (
              <>
                <Select
                  allowDeselect={false}
                  label={t`Провайдер`}
                  value={preferences.provider}
                  disabled={check.isPending}
                  data={aiProviders.map(({ id, label }) => ({ value: id, label }))}
                  onChange={(value) => {
                    const selected = value ?? "";
                    if (isAiProvider(selected)) {
                      keyForm.reset();
                      check.reset();
                      keyAction.reset();
                      savePreferences.mutate({
                        owner: userId,
                        patch: {
                          provider: selected,
                          model: aiProviders.find((item) => item.id === selected)?.model ?? "",
                          baseURL: "",
                        },
                      });
                    }
                  }}
                />
                {preferences.provider === "gigachat" ? (
                  <Text>{t`По умолчанию используется ГигаЧат. Свой ключ не требуется.`}</Text>
                ) : (
                  <>
                    <TextInput
                      label={t`Модель`}
                      value={preferences.model}
                      disabled={check.isPending}
                      onChange={(event) => {
                        check.reset();
                        savePreferences.mutate({
                          owner: userId,
                          patch: { model: event.currentTarget.value },
                        });
                      }}
                    />
                    {preferences.provider === "custom" && (
                      <TextInput
                        type="url"
                        label={t`Адрес API`}
                        value={preferences.baseURL}
                        placeholder="https://api.example.com/v1"
                        disabled={check.isPending}
                        onChange={(event) => {
                          check.reset();
                          savePreferences.mutate({
                            owner: userId,
                            patch: { baseURL: event.currentTarget.value },
                          });
                        }}
                      />
                    )}
                    <Box
                      component="form"
                      onSubmit={keyForm.onSubmit(() => {
                        check.reset();
                        keyAction.mutate({ owner: userId, action: "save" });
                      })}
                    >
                      <Stack gap="sm">
                        <PasswordInput
                          label={t`API-ключ`}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={check.isPending || keyAction.isPending}
                          {...keyForm.getInputProps("key")}
                        />
                        <Group>
                          <Button
                            type="submit"
                            loading={keyAction.isPending && keyAction.variables?.action === "save"}
                            disabled={!keyForm.values.key.trim() || check.isPending}
                          >{t`Использовать ключ`}</Button>
                          <Button
                            loading={keyAction.isPending && keyAction.variables?.action === "clear"}
                            disabled={!hasKey || check.isPending}
                            onClick={() => {
                              keyForm.reset();
                              check.reset();
                              keyAction.mutate({ owner: userId, action: "clear" });
                            }}
                          >{t`Удалить ключ`}</Button>
                        </Group>
                      </Stack>
                    </Box>
                    <Text>{t`Ключ хранится только в памяти вкладки. После перезагрузки введите его снова.`}</Text>
                    {hasKey && <Text role="status">{t`Ключ готов к использованию.`}</Text>}
                  </>
                )}
                <Button
                  loading={check.isPending}
                  disabled={
                    !online ||
                    (preferences.provider !== "gigachat" && (!hasKey || !preferences.model.trim()))
                  }
                  onClick={() => check.mutate(userId)}
                >
                  {check.isPending ? t`Проверяем подключение…` : t`Проверить подключение`}
                </Button>
                {!online && <Text role="status">{t`Для запроса к нейросети нужен интернет.`}</Text>}
                {check.variables === userId && check.isSuccess && (
                  <Text role="status">{t`Нейросеть ответила. Подключение работает.`}</Text>
                )}
                {check.variables === userId && check.isError && (
                  <Alert role="alert">{checkErrorText}</Alert>
                )}
                {((savePreferences.isError && savePreferences.variables?.owner === userId) ||
                  (keyAction.isError && keyAction.variables?.owner === userId)) && (
                  <Alert role="alert">{t`Не удалось сохранить настройки AI.`}</Alert>
                )}
              </>
            )}
          </Stack>
        </Paper>
        <Paper component="section" aria-label={t`Медицинские справочники`} withBorder p="sm">
          <Stack gap="sm">
            <Title order={2}>{t`Медицинские справочники`}</Title>
            <Text>{t`Офлайн доступны только загруженные записи справочника.`}</Text>
            <Box
              component="form"
              onSubmit={catalogForm.onSubmit(() => {
                if (online)
                  search.mutate({
                    data: medicalSearchRequest(medicalSearchSchema.parse(currentInput)),
                  });
              })}
            >
              <Stack gap="sm">
                <Select
                  allowDeselect={false}
                  label={t`Источник данных`}
                  value={source}
                  disabled={search.isPending}
                  data={Object.entries(sourceLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(value) => {
                    const selected = value ?? "";
                    if (isMedicalSource(selected)) {
                      catalogForm.setValues({ source: selected, query: "" });
                      catalogForm.clearErrors();
                      search.reset();
                    }
                  }}
                />
                <TextInput
                  label={
                    source === "icd10" ? t`Код МКБ-10, например J45` : t`Название, термин или код`
                  }
                  maxLength={100}
                  required={source !== "osm"}
                  {...catalogForm.getInputProps("query")}
                  error={
                    catalogForm.errors.query ? t`Проверьте запрос и параметры поиска.` : undefined
                  }
                />
                {source === "osm" && (
                  <Fieldset legend={t`Область поиска учреждений`}>
                    <Stack gap="sm">
                      <NumberInput
                        label={t`Широта`}
                        min={-90}
                        max={90}
                        required
                        {...catalogForm.getInputProps("latitude")}
                        error={
                          catalogForm.errors.latitude
                            ? t`Проверьте запрос и параметры поиска.`
                            : undefined
                        }
                      />
                      <NumberInput
                        label={t`Долгота`}
                        min={-180}
                        max={180}
                        required
                        {...catalogForm.getInputProps("longitude")}
                        error={
                          catalogForm.errors.longitude
                            ? t`Проверьте запрос и параметры поиска.`
                            : undefined
                        }
                      />
                      <NumberInput
                        label={t`Радиус, метры (до 10 000)`}
                        min={100}
                        max={10000}
                        required
                        {...catalogForm.getInputProps("radius")}
                        error={
                          catalogForm.errors.radius
                            ? t`Проверьте запрос и параметры поиска.`
                            : undefined
                        }
                      />
                    </Stack>
                  </Fieldset>
                )}
                <Button type="submit" disabled={!mounted || !online} loading={search.isPending}>
                  {search.isPending ? t`Загружаем…` : t`Найти в источнике`}
                </Button>
              </Stack>
            </Box>
            {(source === "icd10" || source === "orphadata" || source === "pubmed") && (
              <Text>{t`Поиск по английскому термину или коду.`}</Text>
            )}
            {source === "ror" && (
              <Text>{t`ROR содержит организации образования. Наличие в ROR не подтверждает медицинскую аккредитацию.`}</Text>
            )}
            {source === "geofabrik" && (
              <Text>{t`Здесь доступны ссылки на региональные PBF-выгрузки OSM. Архив не является готовым списком больниц и не загружается в браузер автоматически.`}</Text>
            )}
            {!online && (
              <Text role="status">{t`Нет сети: поиск выполняется только по сохранённым записям.`}</Text>
            )}
            {matchesSearch &&
              search.isSuccess &&
              !!search.data.records.length &&
              saveDownloaded.data && (
                <Text role="status">{t`Полученные записи сохранены на устройстве.`}</Text>
              )}
            {matchesSearch && search.data && !saveDownloaded.data && (
              <Alert role="alert">{t`Не удалось сохранить записи. Показанные результаты могут быть недоступны после закрытия приложения.`}</Alert>
            )}
            {search.isError && (
              <Alert role="alert">
                {searchError === "SOURCE_NOT_CONFIGURED"
                  ? t`Для ВОЗ нужно настроить серверные WHO_ICD_CLIENT_ID и WHO_ICD_CLIENT_SECRET.`
                  : searchError === "SOURCE_AUTH_FAILED"
                    ? t`ВОЗ отклонила доступ. Проверьте ключи WHO ICD API в настройках сервера и повторите деплой.`
                    : searchError === "SOURCE_RATE_LIMITED"
                      ? t`Источник ограничил запросы. Повторите позже.`
                      : searchError === "INVALID_SEARCH"
                        ? t`Проверьте запрос и параметры поиска.`
                        : t`Источник сейчас недоступен. Сохранённые записи остаются доступны.`}
              </Alert>
            )}
            {matchesSearch && search.data && (
              <Text>
                {t`Язык данных: ${search.data.dataLanguage}.`}{" "}
                {search.data.truncated && t`Показана ограниченная выборка.`}
              </Text>
            )}
            {!visible.length && (
              <Text>
                {matchesSearch && search.isSuccess
                  ? t`В источнике ничего не найдено.`
                  : t`Сохранённых записей по этому запросу пока нет.`}
              </Text>
            )}
            <List spacing="md">
              {visible.map((record) => (
                <List.Item key={record.id}>
                  <Stack gap="xs">
                    <Text fw={700}>
                      {record.title}
                      {record.code && ` — ${record.code}`}
                    </Text>
                    {record.description && <Text>{record.description}</Text>}
                    <Text>
                      {record.country} {record.dataLanguage} {record.version} ·{" "}
                      {record.fetchedAt.slice(0, 10)}
                    </Text>
                    {record.latitude !== null && record.longitude !== null && (
                      <Text>
                        {record.latitude}, {record.longitude}
                      </Text>
                    )}
                    {record.url && (
                      <Anchor href={record.url} target="_blank" rel="noreferrer noopener">
                        {source === "geofabrik" ? t`Скачать PBF из источника` : t`Открыть источник`}
                      </Anchor>
                    )}
                  </Stack>
                </List.Item>
              ))}
            </List>
            <Text>
              <Anchor href={attribution.url} target="_blank" rel="noreferrer noopener">
                {attribution.label}
              </Anchor>{" "}
              · {attribution.license}
            </Text>
          </Stack>
        </Paper>
      </Stack>
    </Container>
  );
}
