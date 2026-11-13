import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useForceUpdate, useInterval } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { useProjectWork } from "@/src/lib/use-project-work";
import { useVisitAgenda } from "@/src/lib/use-visit-agenda";

export const Route = createFileRoute("/d_/workspace")({ component: WorkspaceOverview });
function WorkspaceOverview() {
  const { t, i18n } = useLingui();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
  const {
    userId,
    online,
    workspace,
    rows,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    records,
    local,
    workRecords,
    localWork,
    downloaded,
    status,
  } = useProjectWork();
  const agenda = useVisitAgenda(userId);
  const projectIds = new Set(rows.map((row) => row.clientId));
  const tasks = workRecords
    .filter(
      (row) =>
        row.entity === "task" &&
        projectIds.has(row.projectClientId) &&
        row.assigneeId === userId &&
        !row.archived &&
        !["done", "cancelled"].includes(row.status),
    )
    .sort((a, b) =>
      a.entity === "task" && b.entity === "task"
        ? (a.dueAt || Infinity) - (b.dueAt || Infinity) || a.createdAt - b.createdAt
        : 0,
    );
  const invitations = records.filter(
    (row) =>
      row.entity === "invitation" &&
      row.inviteeId === userId &&
      row.status === "pending" &&
      row.expiresAt > Date.now(),
  );
  const projects = new Map(rows.map((row) => [row.clientId, row]));
  const activity = new Map(rows.map((row) => [row.clientId, row.updatedAt]));
  for (const row of workRecords)
    activity.set(
      row.projectClientId,
      Math.max(activity.get(row.projectClientId) ?? 0, row.updatedAt),
    );
  const recent = [...rows].sort(
    (a, b) => (activity.get(b.clientId) ?? 0) - (activity.get(a.clientId) ?? 0),
  );
  const rejected = useQuery({
    queryKey: ["overview-rejected", workspace?.scope],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (
        await Promise.all(
          (["project", "protocol", "team", "task", "message", "form"] as const).map((domain) =>
            workspace!.failedActions(domain),
          ),
        )
      ).flat(),
  });
  const domains = {
    form: t`Формы исследования`,
    project: t`Исследование`,
    protocol: t`Протокол исследования`,
    team: t`Команда исследования`,
    task: t`Задачи`,
    message: t`Обсуждение`,
  };
  return (
    <Container component="main" py="md">
      <Stack>
        <Title>{t`Обзор работы`}</Title>
        <Text>{t`Ваши исследования, ближайшие задачи и приглашения выбранной организации.`}</Text>
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
        {(unlock.isError || lock.isError || resume.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {userId && (
          <>
            <Title order={2}>{t`Ближайшие и незавершённые визиты`}</Title>
            {!agenda.workspace && (
              <Alert>
                <Text>{t`Откройте клиническое пространство для просмотра визитов.`}</Text>
                <Anchor component={Link} to="/d/patients">{t`Пациенты`}</Anchor>
              </Alert>
            )}
            {agenda.workspace && (
              <>
                <Text>
                  {options.find((option) => option.value === agenda.workspace!.organizationId)
                    ?.label ?? t`Клиническое пространство`}
                </Text>
                <Text>{t`Визиты открытого клинического пространства; время указано в часовом поясе приёма.`}</Text>
                {!agenda.ready && <Text>{t`Загрузка локальных данных…`}</Text>}
                {agenda.ready && agenda.visits.length === 0 && (
                  <Text>{t`Нет запланированных или незавершённых визитов.`}</Text>
                )}
                {agenda.visits.slice(0, 10).map(({ record, payload, patientName, time }) => (
                  <Paper withBorder p="md" key={record.clientId}>
                    <Stack>
                      <Title order={3}>{patientName}</Title>
                      <Text>
                        {i18n.date(new Date(time.epoch), {
                          timeZone: time.timeZone,
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZoneName: "shortOffset",
                        })}
                      </Text>
                      <Text>{time.timeZone}</Text>
                      <Badge>
                        {payload.status === "inProgress" ? t`Идёт приём` : t`Запланирован`}
                      </Badge>
                      {time.epoch + payload.durationMinutes * 60000 < Date.now() && (
                        <Badge color="orange">{t`Плановое время прошло; уточните результат визита`}</Badge>
                      )}
                      {payload.kind === "visit" && (
                        <Anchor
                          renderRoot={(props) => (
                            <Link
                              {...props}
                              to="/d/patients/$id/visits"
                              params={{ id: record.patientClientId }}
                            />
                          )}
                        >{t`Визиты пациента`}</Anchor>
                      )}
                      {payload.kind === "studyVisit" && (
                        <Anchor
                          renderRoot={(props) => (
                            <Link
                              {...props}
                              to="/d/projects/$id/visits"
                              params={{ id: payload.projectClientId }}
                            />
                          )}
                        >{t`Визиты исследования`}</Anchor>
                      )}
                    </Stack>
                  </Paper>
                ))}
              </>
            )}
          </>
        )}
        {workspace && (
          <>
            <Title order={2}>
              {options.find((option) => option.value === workspace.organizationId)?.label ??
                t`Выбранная организация`}
            </Title>
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
                onClick={() => resume.mutate()}
                loading={resume.isPending}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
                loading={lock.isPending}
              >{t`Сменить организацию или заблокировать`}</Button>
            </Group>
            {!online && (
              <Alert>{t`Показаны сохранённые на устройстве данные. Новые приглашения и изменения коллег появятся после подключения.`}</Alert>
            )}
            <SimpleGrid cols={3}>
              <Paper withBorder p="md">
                <Stack>
                  <Text>{t`Активные задачи`}</Text>
                  <Title order={2}>{localWork.isReady ? i18n.number(tasks.length) : "…"}</Title>
                </Stack>
              </Paper>
              <Paper withBorder p="md">
                <Stack>
                  <Text>{t`Ожидают вашего ответа`}</Text>
                  <Title order={2}>{local.isReady ? i18n.number(invitations.length) : "…"}</Title>
                  <Anchor component={Link} to="/d/invitations">{t`Мои приглашения`}</Anchor>
                </Stack>
              </Paper>
              <Paper withBorder p="md">
                <Stack>
                  <Text>{t`Доступные исследования`}</Text>
                  <Title order={2}>{downloaded.isReady ? i18n.number(rows.length) : "…"}</Title>
                  <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
                </Stack>
              </Paper>
            </SimpleGrid>
            <Title order={2}>{t`Ближайшие задачи`}</Title>
            {!localWork.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
            {localWork.isReady && tasks.length === 0 && (
              <Text>{t`Активных назначенных задач нет.`}</Text>
            )}
            {tasks.slice(0, 10).map(
              (task) =>
                task.entity === "task" && (
                  <Paper withBorder p="md" key={task.key}>
                    <Stack>
                      <Title order={3}>{task.title}</Title>
                      <Text>{projects.get(task.projectClientId)?.title ?? t`Исследование`}</Text>
                      {task.dueAt > 0 ? (
                        <Text>
                          {t`Срок выполнения:`}{" "}
                          {i18n.date(new Date(task.dueAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </Text>
                      ) : (
                        <Text>{t`Без установленного срока`}</Text>
                      )}
                      {task.dueAt > 0 && task.dueAt < Date.now() && (
                        <Badge color="red">{t`Срок прошёл`}</Badge>
                      )}
                      {task.delivery === "local" && (
                        <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                      )}
                      <Anchor
                        renderRoot={(props) => (
                          <Link
                            {...props}
                            to="/d/projects/$id/work"
                            params={{ id: task.projectClientId }}
                          />
                        )}
                      >{t`Открыть задачи исследования`}</Anchor>
                    </Stack>
                  </Paper>
                ),
            )}
            <Title order={2}>{t`Недавняя работа`}</Title>
            {downloaded.isReady && rows.length === 0 && <Text>{t`Исследований пока нет.`}</Text>}
            {recent.slice(0, 5).map((project) => (
              <Paper withBorder p="md" key={project.clientId}>
                <Stack>
                  <Title order={3}>{project.title}</Title>
                  <Text>{project.topic}</Text>
                  <Group>
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/protocol"
                          params={{ id: project.clientId }}
                        />
                      )}
                    >{t`Протокол исследования`}</Anchor>
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/work"
                          params={{ id: project.clientId }}
                        />
                      )}
                    >{t`Обсуждения и задачи`}</Anchor>
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/team"
                          params={{ id: project.clientId }}
                        />
                      )}
                    >{t`Команда исследования`}</Anchor>
                  </Group>
                </Stack>
              </Paper>
            ))}
            <Title order={2}>{t`Изменения, требующие внимания`}</Title>
            {rejected.isError && (
              <Alert color="red">
                {t`Не удалось прочитать сохранённые решения. Повторите попытку.`}
                <Button
                  variant="default"
                  onClick={() => void rejected.refetch()}
                >{t`Повторить`}</Button>
              </Alert>
            )}
            {rejected.isSuccess && rejected.data.length === 0 && (
              <Text>{t`Отклонённых изменений нет.`}</Text>
            )}
            {rejected.data?.map((failure) => (
              <Alert color="yellow" key={failure.id}>
                <Stack>
                  <Text>{domains[failure.domain]}</Text>
                  <Text>{failure.code}</Text>
                  <Text>
                    {i18n.date(new Date(failure.at), { dateStyle: "medium", timeStyle: "short" })}
                  </Text>
                  <Text>{t`Решение сохранено на устройстве. Откройте соответствующий раздел, чтобы сравнить его с текущими данными.`}</Text>
                  {failure.domain === "project" && (
                    <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
                  )}
                  {failure.domain === "form" && (
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/forms"
                          params={{ id: workspace.readForm(failure.envelope).projectClientId }}
                        />
                      )}
                    >{t`Формы исследования`}</Anchor>
                  )}
                  {failure.domain === "protocol" && (
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/protocol"
                          params={{ id: workspace.readProtocol(failure.envelope).projectClientId }}
                        />
                      )}
                    >{t`Протокол исследования`}</Anchor>
                  )}
                  {failure.domain === "team" && failure.operation === "respond" && (
                    <Anchor component={Link} to="/d/invitations">{t`Мои приглашения`}</Anchor>
                  )}
                  {failure.domain === "team" && failure.operation !== "respond" && (
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/team"
                          params={{ id: workspace.readTeam(failure.envelope).projectClientId }}
                        />
                      )}
                    >{t`Команда исследования`}</Anchor>
                  )}
                  {(failure.domain === "task" || failure.domain === "message") && (
                    <Anchor
                      renderRoot={(props) => (
                        <Link
                          {...props}
                          to="/d/projects/$id/work"
                          params={{ id: workspace.readWork(failure.envelope).projectClientId }}
                        />
                      )}
                    >{t`Обсуждения и задачи`}</Anchor>
                  )}
                </Stack>
              </Alert>
            ))}
            <Anchor component={Link} to="/d/patients">{t`Перейти к пациентам`}</Anchor>
          </>
        )}
      </Stack>
    </Container>
  );
}
