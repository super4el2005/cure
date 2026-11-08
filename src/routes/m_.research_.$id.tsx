import { convexQuery } from "@convex-dev/react-query";
import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useInterval, useForceUpdate, useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import { usePublicDirectory } from "@/src/lib/use-public-directory";
export const Route = createFileRoute("/m_/research_/$id")({ component: PublicResearch });
function PublicResearch() {
  const { t } = useLingui();
  const { online } = useNetwork();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
  const { id } = Route.useParams();
  const local = usePublicDirectory({ researchId: id });
  const cached = useLiveQuery(() => local.directory?.researchDetails);
  const remote = useQuery<FunctionReturnType<typeof api.projects.publicDetails>>({
    queryKey: convexQuery(api.projects.publicDetails, { clientId: id }).queryKey,
    enabled: local.failed,
  });
  const study = local.directory ? cached.data?.[0] : remote.data;
  const ready = cached.isReady || remote.isSuccess;
  const stages = {
    draft: t`Черновик`,
    preparing: t`Подготовка`,
    recruiting: t`Набор участников`,
    active: t`Проводится`,
    completed: t`Завершено`,
    archived: t`В архиве`,
  };
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m/research">{t`Все исследования`}</Anchor>
        {!ready && <Loader aria-label={t`Загрузка`} />}
        {remote.isError && (
          <Alert color="red">{t`Не удалось загрузить исследование. Повторите попытку после восстановления связи.`}</Alert>
        )}
        {ready && online && !study && (
          <Alert>{t`Исследование не найдено или не опубликовано.`}</Alert>
        )}
        {!online && !study && (
          <Alert>{t`Страница не сохранена на устройстве. Подключитесь к интернету для загрузки.`}</Alert>
        )}
        {!online && study && (
          <Alert>{t`Сохранённая информация может отличаться от актуальной. Обновления загрузятся после подключения.`}</Alert>
        )}
        {study && (
          <>
            <Title>{study.title}</Title>
            <Group>
              <Badge>
                {study.status === "recruiting" && study.recruitmentUntil <= Date.now()
                  ? t`Набор приостановлен`
                  : stages[study.status]}
              </Badge>
              <Text>
                {study.organization} · {study.country}
              </Text>
            </Group>
            <Text>{study.summary}</Text>
            <Text>{study.topic}</Text>
            <Paper withBorder p="md">
              <Stack>
                <Title order={2}>{t`Условия участия`}</Title>
                <Text>
                  {study.publicEligibility || t`Условия участия уточняются у координатора.`}
                </Text>
              </Stack>
            </Paper>
            <Paper withBorder p="md">
              <Stack>
                <Title order={2}>{t`Связь с координатором`}</Title>
                <Text>
                  {study.publicContact ||
                    t`Войдите и заполните профессиональный профиль для сотрудничества.`}
                </Text>
                <Anchor component={Link} to="/m/profile">{t`Мой профиль`}</Anchor>
              </Stack>
            </Paper>
            <Text>{t`Страница содержит только сведения, разрешённые авторами к публикации.`}</Text>
          </>
        )}
      </Stack>
    </Container>
  );
}
