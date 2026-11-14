import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Select,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useForceUpdate, useInterval } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";

import { useTeamWorkspace } from "@/src/lib/use-team-workspace";

export const Route = createFileRoute("/m_/invitations")({ component: Invitations });
function Invitations() {
  const { t, i18n } = useLingui();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
  const {
    userId,
    workspace,
    status,
    headers,
    options,
    unlockForm,
    unlock,
    lock,
    online,
    resume,
    records,
    local,
    save,
    failures,
  } = useTeamWorkspace();
  const invitations = records.filter(
    (row) => row.entity === "invitation" && row.inviteeId === userId,
  );
  const roles = { coordinator: t`Координатор`, member: t`Участник`, viewer: t`Наблюдатель` };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
        <Title>{t`Мои приглашения`}</Title>
        <Text>{t`Решение сохраняется для выбранной организации. Принятие приглашения не предоставляет прав на изменение данных пациентов.`}</Text>
        {!userId && (
          <Alert>{t`Войдите через Google, чтобы открыть рабочее пространство. Для первого входа нужен интернет.`}</Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="sm">
            <form
              onSubmit={unlockForm.onSubmit((values) =>
                unlock.mutate({ organizationId: values.organizationId }),
              )}
            >
              <Stack gap="sm">
                <Text>{t`Сохраните парольную фразу: без неё локальные данные и очередь изменений не восстановить.`}</Text>
                <Select
                  allowDeselect={false}
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
        {(unlock.isError || lock.isError || resume.isError || save.isError) && (
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
            <Alert>{t`Приглашения и изменения прав вступают в силу после подтверждения сервером. Локальное сохранение не предоставляет доступ к данным.`}</Alert>
            {!local.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
            {local.isReady && invitations.length === 0 && <Text>{t`Приглашений пока нет.`}</Text>}
            {invitations.map(
              (invite) =>
                invite.entity === "invitation" && (
                  <Paper withBorder p="sm" key={invite.key}>
                    <Stack gap="sm">
                      <Title order={2}>{invite.projectTitle || t`Исследование`}</Title>
                      <Badge>{roles[invite.role]}</Badge>
                      <Text>
                        {
                          {
                            pending: t`Ожидает ответа`,
                            accepted: t`Принято`,
                            declined: t`Отклонено`,
                            revoked: t`Отозвано`,
                          }[invite.status]
                        }
                      </Text>
                      <Text>
                        {t`Действует до:`}{" "}
                        {i18n.date(new Date(invite.expiresAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </Text>
                      {invite.delivery === "local" && (
                        <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                      )}
                      {invite.status === "pending" && (
                        <Group>
                          <Button
                            disabled={
                              !workspace.canWrite() ||
                              save.isPending ||
                              invite.expiresAt <= Date.now() ||
                              ["completed", "archived"].includes(invite.projectStatus ?? "archived")
                            }
                            onClick={() =>
                              save.mutate({
                                operation: "respond",
                                expectedRevision: invite.revision,
                                key: invite.key,
                                decision: "accept",
                              })
                            }
                          >{t`Принять приглашение`}</Button>
                          <Button
                            variant="default"
                            disabled={!workspace.canWrite() || save.isPending}
                            onClick={() =>
                              save.mutate({
                                operation: "respond",
                                expectedRevision: invite.revision,
                                key: invite.key,
                                decision: "decline",
                              })
                            }
                          >{t`Отклонить приглашение`}</Button>
                        </Group>
                      )}
                      {invite.status === "accepted" && invite.delivery === "confirmed" && (
                        <Anchor
                          renderRoot={(props) => (
                            <Link
                              {...props}
                              to="/m/projects/$id/team"
                              params={{ id: invite.projectClientId }}
                            />
                          )}
                        >{t`Открыть команду`}</Anchor>
                      )}
                    </Stack>
                  </Paper>
                ),
            )}
            {save.isSuccess && (
              <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
            )}
            {failures.data
              ?.filter((failure) => failure.operation === "respond")
              .map((failure) => (
                <Alert color="yellow" key={failure.id}>
                  <Text>{t`Решение отклонено сервером. Проверьте срок приглашения и повторите действие по текущей записи.`}</Text>
                  <Text>{failure.code}</Text>
                </Alert>
              ))}
          </>
        )}
      </Stack>
    </Container>
  );
}
