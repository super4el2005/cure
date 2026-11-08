import { convexQuery } from "@convex-dev/react-query";
import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  NativeSelect,
  MultiSelect,
  NumberInput,
  Checkbox,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useDisclosure, useMounted, useNetwork } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvex, useConvexAuth } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/src/lib/auth-client";
import type { ClinicalLease } from "@/src/lib/clinical-identity";
import {
  clinicalHeaders,
  clinicalIdentity,
  lockClinicalAccess,
  persistClinicalHeader,
  prepareClinicalVault,
  rememberClinicalIdentity,
} from "@/src/lib/clinical-identity";
import type { ConsentEvent } from "@/src/lib/consent-model";
import { patientFormSchema, patientValueSchema } from "@/src/lib/patient-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
import { retainedWorkspaceOptions, retainWorkspace } from "@/src/lib/retained-workspaces";
import { failureDetails, openLocalData } from "@/src/observability/events";

export const Route = createFileRoute("/m_/patients")({ component: Patients });
function Patients() {
  const { t, i18n } = useLingui();
  const mounted = useMounted();
  const { online } = useNetwork();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const retained = useQuery(retainedWorkspaceOptions);
  const identity = useMemo(
    () => (mounted ? openLocalData("storage.clinical", clinicalIdentity) : undefined),
    [mounted],
  );
  const remembered = useLiveQuery(() => identity);
  const previousUser = remembered.data?.find((row) => row.id === "current");
  const userId = session.data?.user.id ?? previousUser?.userId;
  const details = useQuery<FunctionReturnType<typeof api.profiles.mine>>({
    queryKey: convexQuery(api.profiles.mine, {}).queryKey,
    enabled: isAuthenticated,
  });
  const headers = useQuery({
    queryKey: ["clinical-headers", userId],
    enabled: mounted && Boolean(userId),
    networkMode: "always",
    queryFn: () => clinicalHeaders(userId!),
  });
  const memberships = details.data?.memberships.filter((m) => m.role !== "admin");
  const options =
    isAuthenticated && memberships
      ? memberships.map((m) => ({
          value: m.organizationId,
          label: m.organization?.name ?? m.organizationId,
        }))
      : (headers.data ?? [])
          .filter((h) => h.expiresAt > Date.now())
          .map((h) => ({ value: h.organizationId, label: h.organizationName }));
  const unlockForm = useForm({
    initialValues: { organizationId: "", passphrase: "", confirmation: "" },
    validate: {
      organizationId: (value) => (value ? null : t`Выберите организацию`),
      passphrase: (value) => (value.length >= 12 ? null : t`Не менее 12 символов`),
      confirmation: (value, values) =>
        headers.data?.some((h) => h.organizationId === values.organizationId) ||
        value === values.passphrase
          ? null
          : t`Парольные фразы должны совпадать`,
    },
  });
  const [editing, editor] = useDisclosure(false);
  const [sharing, sharingDialog] = useDisclosure(false);
  const [consenting, consentDialog] = useDisclosure(false);
  const consentForm = useForm({
    initialValues: {
      clientId: "",
      kind: "granted" as "granted" | "withdrawn",
      purpose: "",
      recipients: [] as string[],
      scope: ["sex", "diagnoses"] as ("sex" | "diagnoses")[],
      documentReference: "",
      days: 30 as number | string,
      attested: false,
      failureId: "",
      archivedExpiresAt: 0,
    },
    validate: {
      purpose: (value) => (value.trim() ? null : t`Укажите цель использования данных`),
      documentReference: (value) => (value.trim() ? null : t`Укажите источник подтверждения`),
      recipients: (value) => (value.length ? null : t`Выберите получателей`),
      scope: (value) => (value.length ? null : t`Выберите состав данных`),
      days: (value, values) =>
        values.kind === "withdrawn" ||
        values.archivedExpiresAt ||
        (typeof value === "number" && value >= 1 && value <= 365)
          ? null
          : t`От 1 до 365 дней`,
      attested: (value) =>
        value ? null : t`Подтвердите наличие документированного согласия или отзыва`,
    },
  });
  const shareForm = useForm({
    initialValues: { clientId: "", researcherId: "", days: 30 as number | string, active: true },
    validate: {
      researcherId: (value) => (value ? null : t`Выберите исследователя`),
      days: (value) =>
        typeof value === "number" && value >= 1 && value <= 365 ? null : t`От 1 до 365 дней`,
    },
  });
  const patientForm = useForm({
    initialValues: {
      clientId: "",
      fullName: "",
      birthDate: "",
      sex: "unknown" as "female" | "male" | "unknown",
      diagnosisCodes: "",
      notes: "",
      failureId: "",
    },
    validate: (values) => {
      const errors = schemaResolver(patientFormSchema)(values);
      return Object.fromEntries(
        Object.keys(errors).map((field) => [field, t`Проверьте значение поля`]),
      );
    },
  });
  type Workspace = Awaited<ReturnType<typeof openPatientWorkspace>>;
  const resource = useRef<
    { workspace: Workspace; userId: string; role: "doctor" | "researcher" } | undefined
  >(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [userId]);
  const unlock = useMutation({
    mutationKey: ["patients-open"],
    gcTime: 0,
    scope: { id: "clinical-unlock" },
    networkMode: "always",
    retry: false,
    mutationFn: async (input: Pick<typeof unlockForm.values, "organizationId">) => {
      const passphrase = unlockForm.getValues().passphrase;
      if (!userId) throw new Error("UNAUTHENTICATED");
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      let lease: ClinicalLease;
      let organizationName;
      if (isAuthenticated && online) {
        lease = await convex.query(api.profiles.offlineLease, {
          organizationId: input.organizationId as Id<"organizations">,
          nonce: crypto.randomUUID(),
        });
        if (lease.userId !== userId) throw new Error("ACCOUNT_CHANGED");
        organizationName =
          memberships?.find((m) => m.organizationId === lease.organizationId)?.organization?.name ??
          lease.organizationId;
      } else {
        const existing = clinicalHeaders(userId).find(
          (h) => h.organizationId === input.organizationId && h.expiresAt > Date.now(),
        );
        if (!existing) throw new Error("OFFLINE_NOT_PREPARED");
        lease = {
          userId,
          organizationId: existing.organizationId as Id<"organizations">,
          role: existing.role,
          expiresAt: existing.expiresAt,
        };
        organizationName = existing.organizationName;
      }
      const { vault, header } = await prepareClinicalVault({
        lease,
        organizationName,
        passphrase,
        onlineVerified: isAuthenticated && online,
      });
      if (abort.signal.aborted) {
        vault.lock();
        throw new Error("CANCELLED");
      }
      try {
        persistClinicalHeader(header);
        await rememberClinicalIdentity(
          userId,
          session.data?.user.name ?? previousUser?.label ?? userId,
        );
      } catch (error) {
        vault.lock();
        throw error;
      }
      const workspace = await openPatientWorkspace({
        client: convex,
        ...lease,
        vault,
        signal: abort.signal,
        onAuthRequired: () => {
          void session.refetch();
        },
      }).catch((error) => {
        vault.lock();
        throw error;
      });
      try {
        if (abort.signal.aborted) throw new Error("CANCELLED");
        await retainWorkspace(queryClient, { kind: "patients", userId, workspace });
        resource.current = { workspace, userId, role: lease.role };
        workspace.setAuthenticated(isAuthenticated && online);
        return resource.current;
      } catch (error) {
        await workspace.close();
        throw error;
      }
    },
    onSuccess: () => {
      unlockForm.setFieldValue("passphrase", "");
      unlockForm.setFieldValue("confirmation", "");
      void queryClient.invalidateQueries({ queryKey: ["clinical-headers"] });
    },
  });
  const active = retained.data.find(
    (entry) =>
      entry.kind === "patients" && entry.userId === userId && entry.userId === previousUser?.userId,
  );
  const opened =
    active?.kind === "patients" ? { ...active, role: active.workspace.role } : undefined;
  const workspace = opened?.workspace;
  const downloaded = useLiveQuery(() => workspace?.collection);
  const status = useQuery({
    queryKey: ["patient-status", workspace?.scope],
    gcTime: 0,
    enabled: Boolean(workspace),
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () => ({
      pending: workspace!.executor.getPendingCount() + workspace!.executor.getRunningCount(),
      leader: workspace!.canWrite(),
      online: workspace!.executor.isOnline(),
      failures: await workspace!.failedActions(),
    }),
  });
  const rows =
    workspace && Date.now() < workspace.expiresAt
      ? (downloaded.data
          ?.filter((row) => !row.deleted)
          .flatMap((row) => {
            try {
              return [workspace.read(row)];
            } catch (error) {
              if (error instanceof Error && error.message === "ACCESS_DENIED") return [];
              throw error;
            }
          }) ?? [])
      : [];
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const restore = useMutation({
    mutationKey: ["patients-restore"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.read(failure.envelope);
      if (failure.consentId) {
        const event = row.consentHistory.find((item) => item.id === failure.consentId);
        if (!event) throw new Error("INVALID_VAULT_DATA");
        consentForm.setValues({
          clientId: row.clientId,
          kind: event.kind,
          purpose: event.purpose,
          recipients: event.recipients,
          scope: event.scope,
          documentReference: event.documentReference,
          days: 30,
          archivedExpiresAt: event.expiresAt,
          failureId: failure.id,
          attested: false,
        });
        consentDialog.open();
        return;
      }
      patientForm.setValues({
        ...row,
        diagnosisCodes: row.diagnosisCodes.join(", "),
        failureId: failure.id,
      });
      editor.open();
    },
  });
  const save = useMutation({
    mutationKey: ["patients-save"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (input: typeof patientForm.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const values = patientFormSchema.parse(input);
      const clientId = input.clientId || crypto.randomUUID();
      const result = await workspace.save({
        clientId,
        action: workspace.collection.has(clientId) ? "update" : "create",
        values: patientValueSchema.parse(values),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      patientForm.reset();
      editor.close();
      void status.refetch();
    },
  });
  const remove = useMutation({
    mutationKey: ["patients-delete"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (clientId: string) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.save({ action: "delete", clientId });
    },
    onSuccess: () => {
      void status.refetch();
    },
  });
  const researchers = useQuery({
    queryKey: ["patient-researchers", workspace?.scope, online, isAuthenticated],
    enabled: opened?.role === "doctor",
    networkMode: "always",
    queryFn: async () => {
      if (online && isAuthenticated) {
        const people = await convex.query(api.patients.researchers, {
          organizationId: workspace!.organizationId,
        });
        await workspace!.cacheResearchers(people);
        return people;
      }
      return workspace!.cachedResearchers();
    },
  });
  const consent = useMutation({
    mutationKey: ["patients-consent"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (input: typeof consentForm.values) => {
      if (!workspace || !opened) throw new Error("WORKSPACE_LOCKED");
      const envelope = workspace.collection.get(input.clientId);
      if (!envelope) throw new Error("PATIENT_NOT_FOUND");
      const row = workspace.read(envelope);
      const event: ConsentEvent = {
        id: crypto.randomUUID(),
        version: row.consentHistory.length + 1,
        kind: input.kind,
        purpose: input.purpose.trim(),
        recipients: input.recipients,
        scope: input.scope,
        documentReference: input.documentReference.trim(),
        expiresAt:
          input.archivedExpiresAt ||
          (input.kind === "withdrawn"
            ? (row.consentHistory.at(-1)?.expiresAt ?? Date.now())
            : Date.now() + Number(input.days) * 86400000),
        recordedAt: Date.now(),
        recordedBy: opened.userId,
      };
      const result = await workspace.save({
        action: "consent",
        clientId: input.clientId,
        consent: event,
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      consentDialog.close();
      consentForm.reset();
      void status.refetch();
    },
  });
  const share = useMutation({
    mutationKey: ["patients-share"],
    retry: false,
    mutationFn: async (values: typeof shareForm.values) => {
      if (!workspace || !online || !isAuthenticated) throw new Error("UNAUTHENTICATED");
      return convex.mutation(api.patients.share, {
        organizationId: workspace.organizationId,
        clientId: values.clientId,
        researcherId: values.researcherId,
        expiresAt: Date.now() + Number(values.days) * 24 * 60 * 60 * 1000,
        active: values.active,
      });
    },
    onSuccess: () => {
      sharingDialog.close();
      shareForm.reset();
    },
  });
  const resume = useMutation({
    mutationKey: ["patients-resume"],
    retry: false,
    mutationFn: async () => {
      if (!workspace || !opened) throw new Error("WORKSPACE_LOCKED");
      const lease = await convex.query(api.profiles.offlineLease, {
        organizationId: workspace.organizationId,
        nonce: crypto.randomUUID(),
      });
      if (lease.userId !== opened.userId || lease.role !== opened.role)
        throw new Error("ACCOUNT_CHANGED");
      if (Date.now() >= workspace.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
      workspace.confirmAuthentication();
    },
  });
  const lock = useMutation({
    mutationKey: ["patients-lock"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      try {
        await lockClinicalAccess(queryClient);
      } finally {
        await workspace?.close();
        resource.current = undefined;
        unlock.reset();
        save.reset();
        remove.reset();
        queryClient.removeQueries({ queryKey: ["patient-status"] });
        patientForm.reset();
        editor.close();
        consentDialog.close();
        consentForm.reset();
        consent.reset();
        restore.reset();
      }
    },
  });
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m">{t`На главную`}</Anchor>
        <Title>{t`Пациенты`}</Title>
        {!userId && (
          <Alert>
            {t`Войдите и подтвердите принадлежность к организации, чтобы работать с пациентами.`}
            <Anchor component={Link} to="/m/profile">{t`Открыть профиль`}</Anchor>
          </Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="md">
            <form
              onSubmit={unlockForm.onSubmit((values) =>
                unlock.mutate({ organizationId: values.organizationId }),
              )}
            >
              <Stack>
                <Text>{t`Рабочее пространство защищено парольной фразой. Она не отправляется на сервер. Сохраните её: без неё локальные данные и неотправленные изменения восстановить нельзя.`}</Text>
                <NativeSelect
                  label={t`Организация`}
                  data={[{ value: "", label: t`Выберите организацию` }, ...options]}
                  {...unlockForm.getInputProps("organizationId")}
                />
                <PasswordInput
                  label={t`Парольная фраза локального хранилища`}
                  minLength={12}
                  autoComplete="off"
                  {...unlockForm.getInputProps("passphrase")}
                />
                {!headers.data?.some(
                  (h) => h.organizationId === unlockForm.values.organizationId,
                ) && (
                  <PasswordInput
                    label={t`Повторите парольную фразу`}
                    autoComplete="off"
                    {...unlockForm.getInputProps("confirmation")}
                  />
                )}
                <Button
                  type="submit"
                  loading={unlock.isPending}
                  disabled={options.length === 0}
                >{t`Открыть рабочее пространство`}</Button>
                {options.length === 0 && (
                  <Text>{t`Нет подтверждённой организации или подготовленного офлайн-пространства.`}</Text>
                )}
                {!online && (
                  <Text>{t`Без сети доступны только ранее подготовленные пространства с действующим сроком доступа.`}</Text>
                )}
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError ||
          save.isError ||
          remove.isError ||
          lock.isError ||
          resume.isError ||
          share.isError ||
          consent.isError ||
          restore.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {share.isError && failureDetails(share.error).code === "CONSENT_REQUIRED" && (
          <Alert color="red">{t`Для выдачи доступа сначала зарегистрируйте согласие пациента для выбранного исследователя и дождитесь синхронизации.`}</Alert>
        )}
        {consent.isError && failureDetails(consent.error).code === "CONSENT_EXPIRED" && (
          <Alert color="red">{t`Срок согласия истёк. Для нового срока требуется новая версия с подтверждающим документом.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Badge>
                {opened.role === "doctor"
                  ? t`Врач: создание, чтение, изменение и удаление`
                  : t`Исследователь: только чтение`}
              </Badge>
              <Button
                variant="default"
                disabled={save.isPending || remove.isPending}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            <Text>{t`Сохранение на устройстве и отправка на сервер — разные статусы. Неотправленные изменения остаются в шифруемой очереди.`}</Text>
            <Text>{t`В очереди: ${status.data?.pending ?? 0}`}</Text>
            {!status.data?.leader && (
              <Alert>{t`Изменения доступны в другой открытой вкладке этого пространства. Здесь можно читать данные.`}</Alert>
            )}
            {!status.data?.online && (
              <Alert>
                {t`Синхронизация приостановлена. Нужны сеть и подтверждённая сессия того же пользователя.`}
                <Button
                  variant="default"
                  loading={resume.isPending}
                  disabled={!online}
                  onClick={() => resume.mutate()}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            {Date.now() >= workspace.expiresAt && (
              <Alert color="red">{t`Срок локального доступа истёк. Для продолжения подключитесь и подтвердите доступ заново.`}</Alert>
            )}
            {opened.role === "doctor" && (
              <Button
                disabled={!status.data?.leader || !downloaded.isReady}
                onClick={() => {
                  patientForm.reset();
                  editor.open();
                }}
              >{t`Добавить пациента`}</Button>
            )}
            {(save.isSuccess || remove.isSuccess) && (
              <Alert>{t`Изменение сохранено на устройстве. Состояние отправки показано отдельно.`}</Alert>
            )}
            {editing && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form onSubmit={patientForm.onSubmit((values) => save.mutate(values))}>
                  <Stack>
                    <TextInput
                      label={t`Имя пациента`}
                      required
                      {...patientForm.getInputProps("fullName")}
                    />
                    <TextInput
                      type="date"
                      label={t`Дата рождения`}
                      required
                      {...patientForm.getInputProps("birthDate")}
                    />
                    <NativeSelect
                      label={t`Пол`}
                      data={[
                        { value: "unknown", label: t`Не указан` },
                        { value: "female", label: t`Женский` },
                        { value: "male", label: t`Мужской` },
                      ]}
                      {...patientForm.getInputProps("sex")}
                    />
                    <TextInput
                      label={t`Коды МКБ через запятую`}
                      {...patientForm.getInputProps("diagnosisCodes")}
                    />
                    <Textarea
                      label={t`Клинические заметки`}
                      {...patientForm.getInputProps("notes")}
                    />
                    <Group>
                      <Button
                        type="submit"
                        disabled={!status.data?.leader || !downloaded.isReady}
                        loading={save.isPending}
                      >{t`Сохранить на устройстве`}</Button>
                      <Button variant="default" onClick={editor.close}>{t`Отмена`}</Button>
                    </Group>
                  </Stack>
                </form>
              </Paper>
            )}
            {consent.isSuccess && (
              <Alert>{t`Согласие или отзыв сохранены на устройстве. Для выдачи доступа дождитесь отправки на сервер.`}</Alert>
            )}
            {consenting && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form onSubmit={consentForm.onSubmit((values) => consent.mutate(values))}>
                  <Stack>
                    <Title order={2}>{t`Согласие на исследовательское использование данных`}</Title>
                    <Text>{t`Врач фиксирует уже полученное согласие или его отзыв. Запись в системе не заменяет подпись пациента.`}</Text>
                    <NativeSelect
                      label={t`Действие`}
                      data={[
                        { value: "granted", label: t`Зарегистрировать новую версию согласия` },
                        { value: "withdrawn", label: t`Зарегистрировать отзыв согласия` },
                      ]}
                      {...consentForm.getInputProps("kind")}
                    />
                    <TextInput
                      label={t`Цель использования данных`}
                      maxLength={1000}
                      {...consentForm.getInputProps("purpose")}
                    />
                    <MultiSelect
                      label={t`Получатели данных`}
                      searchable
                      data={[
                        ...new Map([
                          ...(researchers.data ?? []).map(
                            (person) =>
                              [
                                person.userId,
                                {
                                  value: person.userId,
                                  label: person.displayName || person.userId,
                                },
                              ] as const,
                          ),
                          ...consentForm.values.recipients
                            .filter(
                              (id) =>
                                !(researchers.data ?? []).some((person) => person.userId === id),
                            )
                            .map((id) => [id, { value: id, label: id }] as const),
                        ]).values(),
                      ]}
                      {...consentForm.getInputProps("recipients")}
                    />
                    <MultiSelect
                      label={t`Разрешённые категории данных`}
                      data={[
                        { value: "sex", label: t`Пол` },
                        { value: "diagnoses", label: t`Диагнозы` },
                      ]}
                      {...consentForm.getInputProps("scope")}
                    />
                    <NumberInput
                      label={t`Срок действия в днях`}
                      min={1}
                      max={365}
                      allowDecimal={false}
                      disabled={
                        consentForm.values.kind === "withdrawn" ||
                        Boolean(consentForm.values.archivedExpiresAt)
                      }
                      {...consentForm.getInputProps("days")}
                    />
                    {Boolean(consentForm.values.archivedExpiresAt) && (
                      <Alert>
                        <Stack>
                          <Text>{t`Срок восстановленного согласия сохранён без продления.`}</Text>
                          <Text>
                            {new Intl.DateTimeFormat(i18n.locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(consentForm.values.archivedExpiresAt)}
                          </Text>
                          <Button
                            variant="default"
                            onClick={() =>
                              consentForm.setValues({
                                archivedExpiresAt: 0,
                                documentReference: "",
                                attested: false,
                              })
                            }
                          >{t`Оформить новую версию с другим сроком`}</Button>
                        </Stack>
                      </Alert>
                    )}
                    <TextInput
                      label={t`Ссылка или номер документа, подтверждающего согласие или отзыв`}
                      maxLength={1000}
                      {...consentForm.getInputProps("documentReference")}
                    />
                    <Checkbox
                      label={t`Подтверждаю, что согласие или отзыв получены и документированы`}
                      {...consentForm.getInputProps("attested", { type: "checkbox" })}
                    />
                    {!online && (
                      <Text>{t`Без сети доступны ранее загруженные получатели. Отзыв на сервере вступит в силу после синхронизации.`}</Text>
                    )}
                    <Group>
                      <Button
                        type="submit"
                        loading={consent.isPending}
                        disabled={!status.data?.leader || !downloaded.isReady}
                      >{t`Сохранить на устройстве`}</Button>
                      <Button variant="default" onClick={consentDialog.close}>{t`Отмена`}</Button>
                    </Group>
                    <Title order={3}>{t`История согласий`}</Title>
                    {rows
                      .find((row) => row.clientId === consentForm.values.clientId)
                      ?.consentHistory.map((event) => (
                        <Paper key={event.id} withBorder p="xs">
                          <Stack gap="xs">
                            <Text>
                              {event.version} · {event.kind === "granted" ? t`Согласие` : t`Отзыв`}
                            </Text>
                            <Text>{event.purpose}</Text>
                            <Text>{event.documentReference}</Text>
                            <Text>
                              {new Intl.DateTimeFormat(i18n.locale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(event.recordedAt)}
                            </Text>
                          </Stack>
                        </Paper>
                      ))}
                  </Stack>
                </form>
              </Paper>
            )}
            {share.isSuccess && <Alert>{t`Права доступа обновлены на сервере.`}</Alert>}
            {sharing && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form onSubmit={shareForm.onSubmit((values) => share.mutate(values))}>
                  <Stack>
                    <Title order={2}>{t`Доступ исследователя к записи`}</Title>
                    <NativeSelect
                      label={t`Исследователь`}
                      data={[
                        { value: "", label: t`Выберите исследователя` },
                        ...(researchers.data ?? []).map((person) => ({
                          value: person.userId,
                          label: person.displayName || person.userId,
                        })),
                      ]}
                      {...shareForm.getInputProps("researcherId")}
                    />
                    <NumberInput
                      label={t`Срок доступа в днях`}
                      min={1}
                      max={365}
                      {...shareForm.getInputProps("days")}
                    />
                    <Checkbox
                      label={t`Разрешить чтение обезличенных данных`}
                      {...shareForm.getInputProps("active", { type: "checkbox" })}
                    />
                    <Text>{t`Имена, даты рождения и клинические заметки исследователю не передаются. Снимите разрешение, чтобы отозвать доступ.`}</Text>
                    <Group>
                      <Button
                        type="submit"
                        loading={share.isPending}
                        disabled={
                          !status.data?.online ||
                          (shareForm.values.active && (status.data?.pending ?? 0) > 0)
                        }
                      >{t`Сохранить права на сервере`}</Button>
                      <Button variant="default" onClick={sharingDialog.close}>{t`Отмена`}</Button>
                    </Group>
                  </Stack>
                </form>
              </Paper>
            )}
            <Table.ScrollContainer minWidth={420}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t`Пациент`}</Table.Th>
                    <Table.Th>{t`Диагнозы`}</Table.Th>
                    <Table.Th>{t`Версия`}</Table.Th>
                    <Table.Th>{t`Действия`}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row) => (
                    <Table.Tr key={row.clientId}>
                      <Table.Td>{row.fullName || row.clientId}</Table.Td>
                      <Table.Td>
                        {opened.role === "researcher" && !row.consentScope.includes("diagnoses")
                          ? t`Не разрешено согласием`
                          : row.diagnosisCodes.join(", ")}
                      </Table.Td>
                      <Table.Td>{row.revision}</Table.Td>
                      <Table.Td>
                        {opened.role === "doctor" && (
                          <Group>
                            <Button
                              variant="default"
                              onClick={() => {
                                patientForm.setValues({
                                  ...row,
                                  diagnosisCodes: row.diagnosisCodes.join(", "),
                                  failureId: "",
                                });
                                editor.open();
                              }}
                            >{t`Изменить`}</Button>
                            <Button
                              variant="default"
                              onClick={() => {
                                const latest = row.consentHistory.at(-1);
                                consent.reset();
                                share.reset();
                                consentForm.setValues({
                                  archivedExpiresAt: 0,
                                  failureId: "",
                                  clientId: row.clientId,
                                  kind: "granted",
                                  purpose: latest?.purpose ?? "",
                                  recipients: latest?.recipients ?? [],
                                  scope: latest?.scope ?? ["sex", "diagnoses"],
                                  documentReference: "",
                                  days: 30,
                                  attested: false,
                                });
                                consentDialog.open();
                              }}
                            >{t`Согласия`}</Button>
                            <Button
                              variant="default"
                              disabled={!status.data?.online}
                              onClick={() => {
                                shareForm.setFieldValue("clientId", row.clientId);
                                sharingDialog.open();
                              }}
                            >{t`Доступ исследователю`}</Button>
                            <Button
                              color="red"
                              onClick={() =>
                                modals.openConfirmModal({
                                  title: t`Удалить данные пациента?`,
                                  children: <Text>{row.fullName}</Text>,
                                  labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                  onConfirm: () => remove.mutate(row.clientId),
                                })
                              }
                            >{t`Удалить`}</Button>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {downloaded.isReady && rows.length === 0 && (
              <Text>{t`Доступных записей пока нет.`}</Text>
            )}
            {status.data?.failures.map((failure) => (
              <Alert key={failure.id} color="red">
                <Stack>
                  <Text>
                    {failure.code === "REVISION_CONFLICT"
                      ? t`Запись изменена другим участником. Проверьте актуальные данные перед повторным сохранением.`
                      : t`Сервер отклонил изменение. Локальная версия сохранена для разбора.`}
                  </Text>
                  <Button
                    variant="default"
                    onClick={() => restore.mutate(failure)}
                  >{t`Восстановить данные в форме`}</Button>
                </Stack>
              </Alert>
            ))}
          </>
        )}
      </Stack>
    </Container>
  );
}
