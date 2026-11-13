import { useLingui } from "@lingui/react/macro";
import {
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
import { schemaResolver, useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { FailedProjectAction } from "@/src/lib/project-workspace";
import { projectValuesSchema, researchTransitions } from "@/src/lib/research-model";
import type { ProjectValues } from "@/src/lib/research-model";
import { useProjectWorkspace } from "@/src/lib/use-project-workspace";

export const Route = createFileRoute("/m_/projects")({ component: Projects });
function Projects() {
  const { t } = useLingui();
  const {
    userId,
    online,
    workspace,
    rows,
    status,
    headers,
    options,
    unlockForm,
    unlock,
    lock,
    resume,
    downloaded,
  } = useProjectWorkspace();
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: {
      clientId: "",
      expectedRevision: 0,
      failureId: "",
      title: "",
      summary: "",
      topic: "",
      kind: "retrospective" as ProjectValues["kind"],
      status: "draft" as ProjectValues["status"],
      published: false,
      publicEligibility: "",
      publicContact: "",
    },
    validate: (values) =>
      Object.fromEntries(
        Object.keys(schemaResolver(projectValuesSchema)(values)).map((field) => [
          field,
          t`Проверьте значение поля`,
        ]),
      ),
  });
  const kinds = {
    retrospective: t`Ретроспективное`,
    prospective: t`Проспективное`,
    interventional: t`Интервенционное`,
    registry: t`Регистр`,
  };
  const stages = {
    draft: t`Черновик`,
    preparing: t`Подготовка`,
    recruiting: t`Набор участников`,
    active: t`Проводится`,
    completed: t`Завершено`,
    archived: t`В архиве`,
  };
  const original = rows.find((row) => row.clientId === form.values.clientId);
  const allowed = original
    ? [
        original.status,
        ...researchTransitions[original.status].filter(
          (stage) =>
            original.selfRole === "owner" ||
            (stage !== "archived" && original.status !== "archived"),
        ),
      ]
    : ["draft" as const];
  const save = useMutation({
    mutationKey: ["projects-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof form.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const saved = await workspace.save({
        clientId: input.clientId || crypto.randomUUID(),
        expectedRevision: input.expectedRevision,
        values: projectValuesSchema.parse(input),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return saved;
    },
    onSuccess: () => {
      editor.close();
      form.reset();
      void status.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["projects-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.read(failure.envelope);
      form.setValues({
        ...projectValuesSchema.parse(row),
        clientId: row.clientId,
        expectedRevision: workspace.collection.get(row.clientId)?.revision ?? 0,
        failureId: failure.id,
      });
      editor.open();
    },
  });
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m">{t`На главную`}</Anchor>
        <Title>{t`Мои исследования`}</Title>
        <Text>{t`Закрытые проекты, этапы работы и публикация открытого описания исследования.`}</Text>
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
        {(unlock.isError || lock.isError || resume.isError || save.isError || restore.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Badge>
                {status.data?.online ? t`Синхронизация подключена` : t`Локальная работа`}
              </Badge>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
              <Button
                variant="default"
                disabled={!online}
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
                loading={lock.isPending}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {Date.now() >= workspace.expiresAt && (
              <Alert color="yellow">{t`Срок офлайн-доступа истёк. Заблокируйте пространство и откройте его заново с интернетом.`}</Alert>
            )}
            {!status.data?.leader && (
              <Alert>{t`Изменения доступны во вкладке, управляющей очередью синхронизации.`}</Alert>
            )}
            <Button
              disabled={!workspace.canWrite() || Date.now() >= workspace.expiresAt}
              onClick={() => {
                form.reset();
                editor.open();
                save.reset();
              }}
            >{t`Создать исследование`}</Button>
            {editing && (
              <Paper withBorder p="md">
                <form onSubmit={form.onSubmit((input) => save.mutate(input))}>
                  <Stack>
                    <TextInput
                      label={t`Название исследования`}
                      required
                      maxLength={200}
                      {...form.getInputProps("title")}
                    />
                    <Textarea
                      label={t`Открытое описание`}
                      maxLength={5000}
                      {...form.getInputProps("summary")}
                    />
                    <TextInput
                      label={t`Направление исследования`}
                      maxLength={300}
                      {...form.getInputProps("topic")}
                    />
                    <NativeSelect
                      label={t`Тип исследования`}
                      data={Object.entries(kinds).map(([value, label]) => ({ value, label }))}
                      {...form.getInputProps("kind")}
                    />
                    <NativeSelect
                      label={t`Этап исследования`}
                      data={allowed.map((value) => ({ value, label: stages[value] }))}
                      {...form.getInputProps("status")}
                    />
                    <Textarea
                      label={t`Открытые критерии участия`}
                      maxLength={5000}
                      {...form.getInputProps("publicEligibility")}
                    />
                    <TextInput
                      label={t`Открытые контакты координатора`}
                      maxLength={1000}
                      {...form.getInputProps("publicContact")}
                    />
                    <Checkbox
                      label={t`Опубликовать описание в каталоге`}
                      {...form.getInputProps("published", { type: "checkbox" })}
                    />
                    <Alert>{t`В открытое описание не включайте данные пациентов. Публикация и набор проходят серверную проверку; сохранение в очередь не означает их подтверждение.`}</Alert>
                    <Group>
                      <Button
                        type="submit"
                        loading={save.isPending}
                        disabled={!workspace.canWrite() || Date.now() >= workspace.expiresAt}
                      >{t`Сохранить локально`}</Button>
                      <Button
                        variant="default"
                        onClick={() => {
                          editor.close();
                          form.reset();
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
            {!downloaded.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
            {downloaded.isReady && rows.length === 0 && <Text>{t`Исследований пока нет.`}</Text>}
            {rows.map((row) => (
              <Paper key={row.clientId} withBorder p="md">
                <Stack>
                  <Title order={2}>{row.title}</Title>
                  <Group>
                    <Badge>{kinds[row.kind]}</Badge>
                    <Badge>{stages[row.status]}</Badge>
                    <Badge>
                      {
                        {
                          owner: t`Владелец`,
                          coordinator: t`Координатор`,
                          member: t`Участник`,
                          viewer: t`Наблюдатель`,
                        }[row.selfRole]
                      }
                    </Badge>
                  </Group>
                  <Anchor
                    renderRoot={(props) => (
                      <Link
                        {...props}
                        to="/m/projects/$id/protocol"
                        params={{ id: row.clientId }}
                      />
                    )}
                  >{t`Протокол исследования`}</Anchor>
                  <Anchor
                    renderRoot={(props) => (
                      <Link
                        {...props}
                        to="/m/projects/$id/enrollment"
                        params={{ id: row.clientId }}
                      />
                    )}
                  >{t`Журнал набора клиники`}</Anchor>
                  <Anchor
                    renderRoot={(props) => (
                      <Link {...props} to="/m/projects/$id/forms" params={{ id: row.clientId }} />
                    )}
                  >{t`Формы исследования`}</Anchor>
                  <Anchor
                    renderRoot={(props) => (
                      <Link {...props} to="/m/projects/$id/team" params={{ id: row.clientId }} />
                    )}
                  >{t`Команда исследования`}</Anchor>
                  <Anchor
                    renderRoot={(props) => (
                      <Link {...props} to="/m/projects/$id/work" params={{ id: row.clientId }} />
                    )}
                  >{t`Обсуждения и задачи`}</Anchor>
                  <Text>{row.summary}</Text>
                  <Text>{row.topic}</Text>
                  <Text>
                    {t`Версия:`} {row.revision}
                  </Text>
                  {["owner", "coordinator"].includes(row.selfRole) && (
                    <Button
                      variant="default"
                      disabled={!workspace.canWrite() || Date.now() >= workspace.expiresAt}
                      onClick={() => {
                        form.setValues({
                          ...projectValuesSchema.parse(row),
                          clientId: row.clientId,
                          expectedRevision: row.revision,
                          failureId: "",
                        });
                        save.reset();
                        editor.open();
                      }}
                    >{t`Редактировать исследование`}</Button>
                  )}
                </Stack>
              </Paper>
            ))}
            {status.data?.failures.map((failure) => (
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
      </Stack>
    </Container>
  );
}
