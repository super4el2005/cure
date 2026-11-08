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
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useForceUpdate, useInterval } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import type { FailedProjectAction } from "@/src/lib/project-workspace";
import type { InvitedRole } from "@/src/lib/team-model";
import { usePublicDirectory } from "@/src/lib/use-public-directory";
import { useTeamWorkspace } from "@/src/lib/use-team-workspace";

export const Route = createFileRoute("/m_/projects_/$id/team")({ component: Team });
function Team() {
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
    local,
    failures,
    save,
  } = useTeamWorkspace();
  const directory = usePublicDirectory();
  const cachedPeople = useLiveQuery(() => directory.directory?.specialists);
  const remotePeople = useQuery<FunctionReturnType<typeof api.profiles.directory>>({
    queryKey: convexQuery(api.profiles.directory, {}).queryKey,
    enabled: directory.failed,
  });
  const people = directory.directory ? cachedPeople.data : remotePeople.data;
  const project = rows.find((row) => row.clientId === id);
  const members = records.filter((row) => row.entity === "member" && row.projectClientId === id);
  const invitations = records.filter(
    (row) => row.entity === "invitation" && row.projectClientId === id,
  );
  const rejectedDrafts = workspace
    ? (failures.data ?? [])
        .map((failure) => ({ failure, draft: workspace.readTeam(failure.envelope) }))
        .filter((item) => item.draft.projectClientId === id)
    : [];
  const canManage = project && ["owner", "coordinator"].includes(project.selfRole);
  const roleNames = {
    owner: t`Владелец`,
    coordinator: t`Координатор`,
    member: t`Участник`,
    viewer: t`Наблюдатель`,
  };
  const availableRoles: InvitedRole[] =
    project?.selfRole === "owner" ? ["coordinator", "member", "viewer"] : ["member", "viewer"];
  const form = useForm({
    initialValues: { targetProfileId: "", role: "member" as InvitedRole, failureId: "" },
    validate: { targetProfileId: (value) => (value ? null : t`Выберите специалиста`) },
  });
  const invitation = useMutation({
    mutationKey: ["team-invite"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof form.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const person = people?.find((row) => row.id === input.targetProfileId);
      if (!person) throw new Error("INVITEE_UNAVAILABLE");
      const result = await workspace.saveTeam({
        operation: "invite",
        clientId: crypto.randomUUID(),
        projectClientId: id,
        targetProfileId: person.id,
        inviteeName: person.displayName,
        role: input.role,
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: () => {
      form.reset();
      void status.refetch();
      void failures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["team-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const draft = workspace.readTeam(failure.envelope);
      if (failure.operation === "invite" && draft.entity === "invitation")
        form.setValues({
          targetProfileId: draft.targetProfileId,
          role: draft.role,
          failureId: failure.id,
        });
      return failure.id;
    },
  });
  return (
    <Container component="main" py="md">
      <Stack>
        <Group>
          <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
          <Anchor component={Link} to="/m/invitations">{t`Мои приглашения`}</Anchor>
        </Group>
        <Title>{t`Команда исследования`}</Title>
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
          save.isError ||
          invitation.isError ||
          restore.isError) && (
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
            {(!downloaded.isReady || !local.isReady) && (
              <Text>{t`Загрузка локальных данных…`}</Text>
            )}
            {downloaded.isReady && !project && (
              <Alert>{t`Исследование недоступно в выбранной организации или ещё не загружено.`}</Alert>
            )}
            {project && (
              <>
                <Title order={2}>{project.title}</Title>
                {canManage && (
                  <Paper withBorder p="md">
                    <form onSubmit={form.onSubmit((input) => invitation.mutate(input))}>
                      <Stack>
                        <Title order={3}>{t`Пригласить специалиста`}</Title>
                        <Select
                          label={t`Специалист`}
                          searchable
                          data={(people ?? []).map((person) => ({
                            value: person.id,
                            label: `${person.displayName} · ${person.specialty}`,
                          }))}
                          {...form.getInputProps("targetProfileId")}
                        />
                        <Text>{t`Доступны опубликованные проверенные профили из загруженного каталога.`}</Text>
                        <NativeSelect
                          label={t`Роль в исследовании`}
                          data={availableRoles.map((value) => ({ value, label: roleNames[value] }))}
                          {...form.getInputProps("role")}
                        />
                        <Button
                          type="submit"
                          loading={invitation.isPending}
                          disabled={
                            !workspace.canWrite() ||
                            !local.isReady ||
                            ["completed", "archived"].includes(project.status)
                          }
                        >{t`Сохранить приглашение`}</Button>
                      </Stack>
                    </form>
                  </Paper>
                )}
                <Title order={2}>{t`Участники команды`}</Title>
                {members.map(
                  (member) =>
                    member.entity === "member" && (
                      <Paper withBorder p="md" key={member.key}>
                        <Stack>
                          <Title order={3}>{member.displayName || t`Специалист`}</Title>
                          <Text>{member.organization}</Text>
                          <Group>
                            <Badge>{roleNames[member.role]}</Badge>
                            <Badge>{member.active ? t`Активен` : t`Участие прекращено`}</Badge>
                            {member.delivery === "local" && (
                              <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                            )}
                          </Group>
                          {canManage &&
                            member.role !== "owner" &&
                            member.active &&
                            (project.selfRole === "owner" || member.role !== "coordinator") && (
                              <Group>
                                <NativeSelect
                                  label={t`Роль в исследовании`}
                                  value={member.role}
                                  data={availableRoles.map((value) => ({
                                    value,
                                    label: roleNames[value],
                                  }))}
                                  disabled={!workspace.canWrite() || save.isPending}
                                  onChange={(event) =>
                                    save.mutate({
                                      operation: "setMember",
                                      expectedRevision: member.revision,
                                      key: member.key,
                                      role: event.currentTarget.value as InvitedRole,
                                      active: true,
                                    })
                                  }
                                />
                                <Button
                                  color="red"
                                  variant="light"
                                  disabled={!workspace.canWrite() || save.isPending}
                                  onClick={() =>
                                    modals.openConfirmModal({
                                      title: t`Прекратить участие?`,
                                      children: (
                                        <Text>{t`После подтверждения сервером участник потеряет доступ к исследованию. Для возвращения понадобится новое приглашение.`}</Text>
                                      ),
                                      labels: { confirm: t`Прекратить участие`, cancel: t`Отмена` },
                                      onConfirm: () => {
                                        if (member.role !== "owner")
                                          save.mutate({
                                            operation: "setMember",
                                            expectedRevision: member.revision,
                                            key: member.key,
                                            role: member.role,
                                            active: false,
                                          });
                                      },
                                    })
                                  }
                                >{t`Прекратить участие`}</Button>
                              </Group>
                            )}
                        </Stack>
                      </Paper>
                    ),
                )}
                {canManage && (
                  <>
                    <Title order={2}>{t`Приглашения в команду`}</Title>
                    {invitations.map(
                      (invite) =>
                        invite.entity === "invitation" && (
                          <Paper withBorder p="md" key={invite.key}>
                            <Stack>
                              <Text>{invite.inviteeName || t`Специалист`}</Text>
                              <Badge>{roleNames[invite.role]}</Badge>
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
                              {invite.delivery === "local" ? (
                                <Badge color="yellow">{t`Ожидает подтверждения`}</Badge>
                              ) : (
                                <Text>
                                  {t`Действует до:`}{" "}
                                  {i18n.date(new Date(invite.expiresAt), {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })}
                                </Text>
                              )}
                              {invite.status === "pending" &&
                                (project.selfRole === "owner" || invite.role !== "coordinator") && (
                                  <Button
                                    variant="default"
                                    disabled={!workspace.canWrite() || save.isPending}
                                    onClick={() =>
                                      save.mutate({
                                        operation: "revokeInvite",
                                        expectedRevision: invite.revision,
                                        key: invite.key,
                                      })
                                    }
                                  >{t`Отозвать приглашение`}</Button>
                                )}
                            </Stack>
                          </Paper>
                        ),
                    )}
                  </>
                )}
                {(save.isSuccess || invitation.isSuccess) && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
                {rejectedDrafts.map(({ failure, draft }) => (
                  <Alert color="yellow" key={failure.id}>
                    <Stack>
                      <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      <Title order={3}>{t`Сохранённое решение`}</Title>
                      {draft.entity === "member" ? (
                        <Text>
                          {draft.displayName || t`Специалист`} · {roleNames[draft.role]} ·{" "}
                          {draft.active ? t`Активен` : t`Участие прекращено`}
                        </Text>
                      ) : (
                        <Text>
                          {draft.inviteeName || t`Специалист`} · {roleNames[draft.role]} ·{" "}
                          {
                            {
                              pending: t`Ожидает ответа`,
                              accepted: t`Принято`,
                              declined: t`Отклонено`,
                              revoked: t`Отозвано`,
                            }[draft.status]
                          }
                        </Text>
                      )}
                      {failure.operation === "invite" && (
                        <Button
                          variant="default"
                          onClick={() => restore.mutate(failure)}
                        >{t`Открыть сохранённый черновик`}</Button>
                      )}
                      {failure.operation !== "invite" && (
                        <Text>{t`Повторите нужное действие по текущей записи. Отклонённое решение не применяется автоматически.`}</Text>
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
