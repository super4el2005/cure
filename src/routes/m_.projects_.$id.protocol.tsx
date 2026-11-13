import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateTimePicker, toDateTimeString } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { useDisclosure, useInterval, useForceUpdate } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import "dayjs/locale/ru";

import type { FailedProjectAction } from "@/src/lib/project-workspace";
import { protocolValuesSchema } from "@/src/lib/research-model";
import { useProjectWorkspace } from "@/src/lib/use-project-workspace";

export const Route = createFileRoute("/m_/projects_/$id/protocol")({ component: Protocol });
function Protocol() {
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    userId,
    workspace,
    rows,
    status,
    headers,
    options,
    unlockForm,
    unlock,
    lock,
    online,
    resume,
    downloaded,
  } = useProjectWorkspace();
  const [editing, editor] = useDisclosure(false);
  const local = useLiveQuery(() => workspace?.protocols);
  const project = rows.find((row) => row.clientId === id);
  const history =
    workspace && Date.now() < workspace.expiresAt
      ? (local.data
          ?.filter((row) => row.clientId !== workspace.protocolSnapshotId)
          .map(workspace.readProtocol)
          .filter((row) => row.projectClientId === id)
          .sort((a, b) => b.version - a.version) ?? [])
      : [];
  const canEdit =
    workspace?.canWrite() &&
    project &&
    ["owner", "coordinator"].includes(project.selfRole) &&
    !["completed", "archived"].includes(project.status);
  const form = useForm({
    initialValues: {
      expectedVersion: 0,
      hypothesis: "",
      inclusion: "",
      exclusion: "",
      endpoints: "",
      analysisPlan: "",
      ethicsApproved: false,
      ethicsReference: "",
      ethicsDate: null as string | null,
      attested: false,
      failureId: "",
    },
    validate: (values) => {
      const result = protocolValuesSchema.safeParse({
        ...values,
        ethicsExpiresAt: values.ethicsDate ? dayjs(values.ethicsDate).valueOf() : 0,
      });
      const errors: Record<string, string> = {};
      if (!result.success)
        for (const issue of result.error.issues)
          errors[String(issue.path[0] ?? "ethicsReference")] = t`Проверьте значение поля`;
      if (
        values.ethicsApproved &&
        (!values.ethicsDate || dayjs(values.ethicsDate).valueOf() <= Date.now())
      )
        errors.ethicsDate = t`Укажите действующий срок разрешения`;
      if (values.ethicsApproved && !values.attested)
        errors.attested = t`Подтвердите наличие документа`;
      return errors;
    },
  });
  const rejected = useQuery({
    queryKey: ["protocol-failures", workspace?.scope, id],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("protocol")).filter(
        (failure) => workspace!.readProtocol(failure.envelope).projectClientId === id,
      ),
  });
  const save = useMutation({
    mutationKey: ["protocol-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof form.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveProtocol({
        clientId: crypto.randomUUID(),
        projectClientId: id,
        expectedVersion: input.expectedVersion,
        values: protocolValuesSchema.parse({
          ...input,
          ethicsExpiresAt: input.ethicsDate ? dayjs(input.ethicsDate).valueOf() : 0,
        }),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      form.reset();
      editor.close();
      void rejected.refetch();
      void status.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["protocol-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.readProtocol(failure.envelope);
      form.setValues({
        ...row,
        expectedVersion: history[0]?.version ?? 0,
        ethicsDate: row.ethicsExpiresAt ? toDateTimeString(row.ethicsExpiresAt) : null,
        attested: false,
        failureId: failure.id,
      });
      editor.open();
    },
  });
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
        <Title>{t`Протокол исследования`}</Title>
        {!userId && (
          <Alert>{t`Войдите через Google, чтобы открыть рабочее пространство. Для первого входа нужен интернет.`}</Alert>
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
                  disabled={options.length === 0}
                  loading={unlock.isPending}
                >{t`Открыть рабочее пространство`}</Button>
                {options.length === 0 && (
                  <Text>{t`Нет подтверждённой организации или подготовленного офлайн-пространства.`}</Text>
                )}
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError || lock.isError || resume.isError || save.isError || restore.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
              <Button
                variant="default"
                disabled={!online}
                onClick={() => resume.mutate()}
                loading={resume.isPending}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {(!downloaded.isReady || !local.isReady) && (
              <Text>{t`Загрузка локальных данных…`}</Text>
            )}
            {downloaded.isReady && !project && (
              <Alert>{t`Исследование недоступно в выбранной организации или ещё не загружено.`}</Alert>
            )}
            {project && (
              <>
                <Title order={2}>{project.title}</Title>
                <Text>{t`Прежние версии доступны только для чтения. Изменение протокола при наборе требует повторного перехода к подготовке.`}</Text>
                <Button
                  disabled={!canEdit || !local.isReady}
                  onClick={() => {
                    form.reset();
                    const latest = history[0];
                    if (latest)
                      form.setValues({
                        ...latest,
                        expectedVersion: latest.version,
                        ethicsDate: latest.ethicsExpiresAt
                          ? toDateTimeString(latest.ethicsExpiresAt)
                          : null,
                        attested: false,
                        failureId: "",
                      });
                    editor.open();
                    save.reset();
                  }}
                >{t`Добавить версию протокола`}</Button>
                {editing && (
                  <Paper withBorder p="md">
                    <form onSubmit={form.onSubmit((input) => save.mutate(input))}>
                      <Stack>
                        <Textarea
                          label={t`Гипотеза исследования`}
                          required
                          maxLength={5000}
                          {...form.getInputProps("hypothesis")}
                        />
                        <Textarea
                          label={t`Критерии включения`}
                          maxLength={5000}
                          {...form.getInputProps("inclusion")}
                        />
                        <Textarea
                          label={t`Критерии исключения`}
                          maxLength={5000}
                          {...form.getInputProps("exclusion")}
                        />
                        <Textarea
                          label={t`Конечные точки`}
                          required
                          maxLength={5000}
                          {...form.getInputProps("endpoints")}
                        />
                        <Textarea
                          label={t`План анализа`}
                          required
                          maxLength={10000}
                          {...form.getInputProps("analysisPlan")}
                        />
                        <Checkbox
                          label={t`Получено разрешение этического комитета`}
                          {...form.getInputProps("ethicsApproved", { type: "checkbox" })}
                        />
                        <TextInput
                          label={t`Номер или ссылка на этическое разрешение`}
                          maxLength={1000}
                          {...form.getInputProps("ethicsReference")}
                        />
                        <DateTimePicker
                          label={t`Срок действия этического разрешения`}
                          locale={i18n.locale}
                          clearable
                          {...form.getInputProps("ethicsDate")}
                        />
                        {form.values.ethicsApproved && (
                          <Checkbox
                            label={t`Подтверждаю наличие разрешения для этой версии протокола`}
                            {...form.getInputProps("attested", { type: "checkbox" })}
                          />
                        )}
                        <Alert>{t`Регистрация документа не заменяет его проверку этическим комитетом. Не включайте в протокол идентифицирующие данные пациентов.`}</Alert>
                        <Group>
                          <Button
                            type="submit"
                            loading={save.isPending}
                            disabled={!canEdit}
                          >{t`Сохранить локально`}</Button>
                          <Button
                            variant="default"
                            onClick={() => {
                              form.reset();
                              editor.close();
                            }}
                          >{t`Отмена`}</Button>
                        </Group>
                      </Stack>
                    </form>
                  </Paper>
                )}
                {save.isSuccess && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
                {local.isReady && history.length === 0 && (
                  <Text>{t`Протокол ещё не добавлен.`}</Text>
                )}
                <Accordion>
                  {history.map((version) => (
                    <Accordion.Item value={version.clientId} key={version.clientId}>
                      <Accordion.Control>
                        {t`Версия:`} {version.version}
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack>
                          <Title order={3}>{t`Гипотеза исследования`}</Title>
                          <Text>{version.hypothesis}</Text>
                          <Title order={3}>{t`Критерии включения`}</Title>
                          <Text>{version.inclusion}</Text>
                          <Title order={3}>{t`Критерии исключения`}</Title>
                          <Text>{version.exclusion}</Text>
                          <Title order={3}>{t`Конечные точки`}</Title>
                          <Text>{version.endpoints}</Text>
                          <Title order={3}>{t`План анализа`}</Title>
                          <Text>{version.analysisPlan}</Text>
                          <Badge>
                            {version.ethicsApproved && version.ethicsExpiresAt > Date.now()
                              ? t`Разрешение зарегистрировано`
                              : t`Нет действующего этического разрешения`}
                          </Badge>
                          <Text>{version.ethicsReference}</Text>
                          {version.ethicsExpiresAt > 0 && (
                            <Text>
                              {i18n.date(new Date(version.ethicsExpiresAt), {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })}
                            </Text>
                          )}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
                {rejected.data?.map((failure) => (
                  <Alert color="yellow" key={failure.id}>
                    <Stack>
                      <Text>{t`Сервер отклонил изменение. Черновик сохранён; откройте его и сравните с текущей версией.`}</Text>
                      <Text>{failure.code}</Text>
                      <Button
                        variant="default"
                        onClick={() => restore.mutate(failure)}
                      >{t`Открыть сохранённый черновик`}</Button>
                    </Stack>
                  </Alert>
                ))}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
