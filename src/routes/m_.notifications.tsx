import { useLingui } from "@lingui/react/macro";
import { Alert, Anchor, Badge, Container, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useNetwork } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";

import { authClient } from "@/src/lib/auth-client";
import type { NotificationItem, NotificationKind } from "@/src/lib/notification-model";
import { useNotifications } from "@/src/lib/use-notifications";

export const Route = createFileRoute("/m_/notifications")({ component: Notifications });
function Notifications() {
  const { t, i18n } = useLingui();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const { online } = useNetwork();
  const { feed, items } = useNotifications(userId, online);
  const kinds: Record<NotificationKind, string> = {
    invitation: t`Приглашение в исследование`,
    task: t`Задача`,
    safetyReview: t`Рассмотрение события`,
    visitWindow: t`Окно визита`,
  };
  const ItemLink = ({ item, label }: { item: NotificationItem; label: string }) => {
    if (item.kind === "invitation")
      return (
        <Anchor component={Link} to="/m/invitations">
          {label}
        </Anchor>
      );
    if (item.kind === "task")
      return (
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/m/projects/$id/work" params={{ id: item.projectClientId }} />
          )}
        >
          {label}
        </Anchor>
      );
    if (item.kind === "safetyReview")
      return (
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/m/projects/$id/safety" params={{ id: item.projectClientId }} />
          )}
        >
          {label}
        </Anchor>
      );
    return (
      <Anchor
        renderRoot={(props) => (
          <Link {...props} to="/m/projects/$id/visits" params={{ id: item.projectClientId }} />
        )}
      >
        {label}
      </Anchor>
    );
  };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Title>{t`Уведомления`}</Title>
        {!userId && (
          <Alert>{t`Войдите через Google, чтобы увидеть уведомления. Для первого входа нужен интернет.`}</Alert>
        )}
        {userId && !online && <Alert>{t`Лента уведомлений требует сети и активной сессии.`}</Alert>}
        {userId && online && feed.isPending && <Text>{t`Загрузка уведомлений…`}</Text>}
        {userId && online && feed.isError && (
          <Alert color="red">{t`Не удалось загрузить уведомления. Повторите попытку позже.`}</Alert>
        )}
        {userId && online && feed.isSuccess && (
          <>
            <Alert>{t`Показаны открытые приглашения, назначенные задачи, назначенные рассмотрения событий и визиты с открывшимся окном. Лента обновляется автоматически и не хранится на устройстве.`}</Alert>
            {items.length === 0 ? (
              <Text>{t`Открытых уведомлений нет.`}</Text>
            ) : (
              items.map((item) => (
                <Paper withBorder p="sm" key={item.id}>
                  <Stack gap="xs">
                    <Group>
                      <Badge {...(item.overdue ? { color: "red" } : {})}>{kinds[item.kind]}</Badge>
                      {item.overdue && <Badge color="red">{t`Срок прошёл`}</Badge>}
                      {item.dueOn && (
                        <Text size="sm">
                          {t`Срок:`}{" "}
                          {i18n.date(new Date(`${item.dueOn}T00:00:00Z`), { dateStyle: "medium" })}
                        </Text>
                      )}
                    </Group>
                    <ItemLink
                      item={item}
                      label={item.title || item.projectTitle || item.projectClientId}
                    />
                    {item.detail && <Text size="sm">{item.detail}</Text>}
                  </Stack>
                </Paper>
              ))
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
