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
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateTimePicker, toDateTimeString } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { useDisclosure, useForceUpdate, useInterval } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import dayjs from "dayjs";
import "dayjs/locale/ru";

import { taskValuesSchema, messageBodySchema } from "@/src/lib/project-work-model";
import type { TaskValues, WorkCommand } from "@/src/lib/project-work-model";
import type { FailedProjectAction } from "@/src/lib/project-workspace";
import { useProjectWork } from "@/src/lib/use-project-work";

export const Route = createFileRoute("/m_/projects_/$id/work")({ component: ProjectWork });
function ProjectWork() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
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
    records,
    workRecords,
    localWork,
    workFailures,
  } = useProjectWork();
  const project = rows.find((row) => row.clientId === id);
  const manager = project && ["owner", "coordinator"].includes(project.selfRole);
  const canWrite =
    workspace?.canWrite() &&
    project &&
    project.selfRole !== "viewer" &&
    project.status !== "archived";
  const members = records.filter((row) => row.entity === "member" && row.projectClientId === id);
  const names = new Map(
    members.flatMap((row) =>
      row.entity === "member" ? [[row.userId, row.displayName || t`Специалист`] as const] : [],
    ),
  );
  const [editingTask, taskEditor] = useDisclosure(false);
  const filters = useForm({ initialValues: { query: "", archived: false } });
  const tasks = workRecords
    .filter(
      (row) =>
        row.entity === "task" &&
        row.projectClientId === id &&
        (filters.values.archived || !row.archived) &&
        `${row.title} ${row.description}`
          .toLocaleLowerCase()
          .includes(filters.values.query.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      a.entity === "task" && b.entity === "task"
        ? (a.dueAt || Infinity) - (b.dueAt || Infinity) || a.createdAt - b.createdAt
        : 0,
    );
  const messages = workRecords
    .filter((row) => row.entity === "message" && row.projectClientId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
  const stages = {
    todo: t`К выполнению`,
    inProgress: t`В работе`,
    done: t`Выполнено`,
    cancelled: t`Отменено`,
  };
  const priorities = { low: t`Низкий`, normal: t`Обычный`, high: t`Высокий` };
  const taskForm = useForm({
    initialValues: {
      clientId: "",
      expectedRevision: 0,
      title: "",
      description: "",
      status: "todo" as TaskValues["status"],
      priority: "normal" as TaskValues["priority"],
      assigneeId: "",
      dueDate: null as string | null,
      archived: false,
      failureId: "",
    },
    validate: (values) => {
      const result = taskValuesSchema.safeParse({
        ...values,
        dueAt: values.dueDate ? dayjs(values.dueDate).valueOf() : 0,
      });
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [
              issue.path[0] === "dueAt" ? "dueDate" : String(issue.path[0]),
              t`Проверьте значение поля`,
            ]),
          );
    },
  });
  const messageForm = useForm({
    initialValues: { clientId: "", expectedRevision: 0, body: "", failureId: "" },
    validate: {
      body: (value) =>
        messageBodySchema.safeParse(value).success
          ? null
          : t`Введите сообщение от 1 до 10000 символов`,
    },
  });
  const saveTask = useMutation({
    mutationKey: ["task-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof taskForm.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveWork({
        entity: "task",
        clientId: input.clientId || crypto.randomUUID(),
        expectedRevision: input.expectedRevision,
        projectClientId: id,
        values: taskValuesSchema.parse({
          ...input,
          dueAt: input.dueDate ? dayjs(input.dueDate).valueOf() : 0,
        }),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      taskForm.reset();
      taskEditor.close();
      void status.refetch();
      void workFailures.refetch();
    },
  });
  const saveMessage = useMutation({
    mutationKey: ["message-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof messageForm.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveWork({
        entity: "message",
        clientId: input.clientId || crypto.randomUUID(),
        expectedRevision: input.expectedRevision,
        projectClientId: id,
        action: input.clientId ? "update" : "create",
        body: messageBodySchema.parse(input.body),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      messageForm.reset();
      void status.refetch();
      void workFailures.refetch();
    },
  });
  const apply = useMutation({
    mutationKey: ["project-work-action"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (command: WorkCommand) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveWork(command);
    },
    onSuccess: () => {
      void status.refetch();
      void workFailures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["project-work-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const draft = workspace.readWork(failure.envelope);
      const currentEnvelope = workspace.work.get(draft.key);
      const current = currentEnvelope ? workspace.readWork(currentEnvelope) : undefined;
      if (draft.entity === "task") {
        taskForm.setValues({
          ...taskValuesSchema.parse(draft),
          clientId: current ? draft.clientId : "",
          expectedRevision: current?.revision ?? 0,
          dueDate: draft.dueAt ? toDateTimeString(draft.dueAt) : null,
          failureId: failure.id,
        });
        taskEditor.open();
      } else if (draft.entity === "message" && !draft.deleted) {
        const editable =
          current?.entity === "message" && !current.deleted && current.createdBy === userId;
        messageForm.setValues({
          body: draft.body,
          clientId: editable ? draft.clientId : "",
          expectedRevision: editable ? current.revision : 0,
          failureId: failure.id,
        });
      }
    },
  });
  const failures = workspace
    ? (workFailures.data ?? [])
        .flatMap((failure) => {
          const draft = workspace.readWork(failure.envelope);
          return draft.entity === "credit" ? [] : [{ failure, draft }];
        })
        .filter((item) => item.draft.projectClientId === id)
    : [];
  return (
    <Container component="main" py="md">
      <Stack>
        <Group>
          <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
          <Anchor
            renderRoot={(props) => <Link {...props} to="/m/projects/$id/team" params={{ id }} />}
          >{t`Команда исследования`}</Anchor>
        </Group>
        <Title>{t`Обсуждения и задачи исследования`}</Title>
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
        {(unlock.isError ||
          lock.isError ||
          resume.isError ||
          saveTask.isError ||
          saveMessage.isError ||
          apply.isError ||
          restore.isError) && (
          <Alert color="red">{t`Не удалось сохранить изменение. Проверьте права и текущую версию записи. Ваш ввод остаётся в форме.`}</Alert>
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
            <Alert>{t`Не указывайте в обсуждениях имена, контакты и другие идентифицирующие данные пациентов. Используйте разрешённые исследовательские обозначения.`}</Alert>
            {(!downloaded.isReady || !localWork.isReady) && (
              <Text>{t`Загрузка локальных данных…`}</Text>
            )}
            {downloaded.isReady && !project && (
              <Alert>{t`Исследование недоступно в выбранной организации или ещё не загружено.`}</Alert>
            )}
            {project && (
              <>
                <Title order={2}>{project.title}</Title>
                <Tabs defaultValue="tasks">
                  <Tabs.List>
                    <Tabs.Tab value="tasks">{t`Задачи`}</Tabs.Tab>
                    <Tabs.Tab value="discussion">{t`Обсуждение`}</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="tasks" pt="md">
                    <Stack>
                      <TextInput label={t`Поиск задач`} {...filters.getInputProps("query")} />
                      <Checkbox
                        label={t`Показывать архивные задачи`}
                        {...filters.getInputProps("archived", { type: "checkbox" })}
                      />
                      <Button
                        disabled={!canWrite || !localWork.isReady}
                        onClick={() => {
                          taskForm.reset();
                          taskForm.setFieldValue("assigneeId", userId ?? "");
                          taskEditor.open();
                        }}
                      >{t`Создать задачу`}</Button>
                      {editingTask && (
                        <Paper withBorder p="md">
                          <form onSubmit={taskForm.onSubmit((input) => saveTask.mutate(input))}>
                            <Stack>
                              <TextInput
                                label={t`Название задачи`}
                                required
                                maxLength={200}
                                {...taskForm.getInputProps("title")}
                              />
                              <Textarea
                                label={t`Описание задачи`}
                                maxLength={5000}
                                {...taskForm.getInputProps("description")}
                              />
                              <NativeSelect
                                label={t`Исполнитель`}
                                disabled={!manager}
                                data={[
                                  { value: "", label: t`Выберите исполнителя` },
                                  ...members.flatMap((member) =>
                                    member.entity === "member" &&
                                    member.active &&
                                    member.role !== "viewer"
                                      ? [
                                          {
                                            value: member.userId,
                                            label: member.displayName || t`Специалист`,
                                          },
                                        ]
                                      : [],
                                  ),
                                ]}
                                {...taskForm.getInputProps("assigneeId")}
                              />
                              <NativeSelect
                                label={t`Статус задачи`}
                                data={Object.entries(stages).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...taskForm.getInputProps("status")}
                              />
                              <NativeSelect
                                label={t`Приоритет`}
                                data={Object.entries(priorities).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...taskForm.getInputProps("priority")}
                              />
                              <DateTimePicker
                                label={t`Срок выполнения`}
                                clearable
                                locale={i18n.locale}
                                {...taskForm.getInputProps("dueDate")}
                              />
                              <Group>
                                <Button
                                  type="submit"
                                  disabled={!canWrite}
                                  loading={saveTask.isPending}
                                >{t`Сохранить локально`}</Button>
                                <Button
                                  variant="default"
                                  onClick={() => {
                                    taskForm.reset();
                                    taskEditor.close();
                                  }}
                                >{t`Отмена`}</Button>
                              </Group>
                            </Stack>
                          </form>
                        </Paper>
                      )}
                      {localWork.isReady && tasks.length === 0 && <Text>{t`Задач пока нет.`}</Text>}
                      {tasks.map(
                        (task) =>
                          task.entity === "task" && (
                            <Paper withBorder p="md" key={task.key}>
                              <Stack>
                                <Title order={3}>{task.title}</Title>
                                <Text>{task.description}</Text>
                                <Text>
                                  {t`Исполнитель:`}{" "}
                                  {names.get(task.assigneeId) ?? t`Бывший участник`}
                                </Text>
                                <Group>
                                  <Badge>{stages[task.status]}</Badge>
                                  <Badge>{priorities[task.priority]}</Badge>
                                  {task.archived && <Badge>{t`В архиве`}</Badge>}
                                  {task.delivery === "local" && (
                                    <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                                  )}
                                </Group>
                                {task.dueAt > 0 && (
                                  <Text
                                    {...(task.dueAt < Date.now() &&
                                    !["done", "cancelled"].includes(task.status)
                                      ? { c: "red" }
                                      : {})}
                                  >
                                    {t`Срок выполнения:`}{" "}
                                    {i18n.date(new Date(task.dueAt), {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    })}
                                  </Text>
                                )}
                                {canWrite &&
                                  (manager ||
                                    task.createdBy === userId ||
                                    task.assigneeId === userId) && (
                                    <Group>
                                      <Button
                                        variant="default"
                                        onClick={() => {
                                          taskForm.setValues({
                                            ...taskValuesSchema.parse(task),
                                            clientId: task.clientId,
                                            expectedRevision: task.revision,
                                            dueDate: task.dueAt
                                              ? toDateTimeString(task.dueAt)
                                              : null,
                                            failureId: "",
                                          });
                                          taskEditor.open();
                                        }}
                                      >{t`Редактировать задачу`}</Button>
                                      {(manager || task.createdBy === userId) && (
                                        <Button
                                          variant="default"
                                          disabled={apply.isPending}
                                          onClick={() =>
                                            apply.mutate({
                                              entity: "task",
                                              clientId: task.clientId,
                                              projectClientId: id,
                                              expectedRevision: task.revision,
                                              values: {
                                                ...taskValuesSchema.parse(task),
                                                archived: !task.archived,
                                              },
                                            })
                                          }
                                        >
                                          {task.archived
                                            ? t`Вернуть из архива`
                                            : t`Архивировать задачу`}
                                        </Button>
                                      )}
                                    </Group>
                                  )}
                              </Stack>
                            </Paper>
                          ),
                      )}
                    </Stack>
                  </Tabs.Panel>
                  <Tabs.Panel value="discussion" pt="md">
                    <Stack>
                      {messages.map(
                        (message) =>
                          message.entity === "message" && (
                            <Paper withBorder p="md" key={message.key}>
                              <Stack>
                                <Group>
                                  <Text fw={500}>
                                    {names.get(message.createdBy) ?? t`Бывший участник`}
                                  </Text>
                                  <Text>
                                    {i18n.date(new Date(message.createdAt), {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    })}
                                  </Text>
                                  {message.delivery === "local" && (
                                    <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                                  )}
                                </Group>
                                <Text>{message.deleted ? t`Сообщение удалено` : message.body}</Text>
                                {!message.deleted && canWrite && (
                                  <Group>
                                    {message.createdBy === userId && (
                                      <Button
                                        variant="default"
                                        onClick={() =>
                                          messageForm.setValues({
                                            clientId: message.clientId,
                                            expectedRevision: message.revision,
                                            body: message.body,
                                            failureId: "",
                                          })
                                        }
                                      >{t`Редактировать сообщение`}</Button>
                                    )}
                                    {(manager || message.createdBy === userId) && (
                                      <Button
                                        color="red"
                                        variant="light"
                                        onClick={() =>
                                          modals.openConfirmModal({
                                            title: t`Удалить сообщение?`,
                                            children: (
                                              <Text>{t`Текст сообщения будет удалён после синхронизации. Запись о действии сохранится в истории.`}</Text>
                                            ),
                                            labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                            onConfirm: () =>
                                              apply.mutate({
                                                entity: "message",
                                                clientId: message.clientId,
                                                projectClientId: id,
                                                expectedRevision: message.revision,
                                                action: "delete",
                                                body: "",
                                              }),
                                          })
                                        }
                                      >{t`Удалить сообщение`}</Button>
                                    )}
                                  </Group>
                                )}
                              </Stack>
                            </Paper>
                          ),
                      )}
                      {localWork.isReady && messages.length === 0 && (
                        <Text>{t`Обсуждение ещё не началось.`}</Text>
                      )}
                      {canWrite && (
                        <form onSubmit={messageForm.onSubmit((input) => saveMessage.mutate(input))}>
                          <Stack>
                            <Textarea
                              label={
                                messageForm.values.clientId
                                  ? t`Редактирование сообщения`
                                  : t`Новое сообщение`
                              }
                              required
                              maxLength={10000}
                              {...messageForm.getInputProps("body")}
                            />
                            <Group>
                              <Button
                                type="submit"
                                disabled={!localWork.isReady}
                                loading={saveMessage.isPending}
                              >{t`Сохранить сообщение`}</Button>
                              {messageForm.values.clientId && (
                                <Button
                                  variant="default"
                                  onClick={() => messageForm.reset()}
                                >{t`Отмена`}</Button>
                              )}
                            </Group>
                          </Stack>
                        </form>
                      )}
                    </Stack>
                  </Tabs.Panel>
                </Tabs>
                {(saveTask.isSuccess || saveMessage.isSuccess || apply.isSuccess) && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
                {failures.map(({ failure, draft }) => (
                  <Alert color="yellow" key={failure.id}>
                    <Stack>
                      <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      <Title order={3}>{t`Сохранённое решение`}</Title>
                      <Text>
                        {draft.entity === "task"
                          ? draft.title
                          : draft.deleted
                            ? t`Удаление сообщения`
                            : draft.body}
                      </Text>
                      {(draft.entity === "task" || !draft.deleted) && (
                        <Button
                          variant="default"
                          onClick={() => restore.mutate(failure)}
                        >{t`Открыть сохранённый черновик`}</Button>
                      )}
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
