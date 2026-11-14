import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useInterval, useForceUpdate } from "@mantine/hooks";
import { useCounter, useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { usePaginatedQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { usePublicDirectory } from "@/src/lib/use-public-directory";
export const Route = createFileRoute("/d_/research")({ component: ResearchDirectory });
function ResearchDirectory() {
  const { t } = useLingui();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
  const { online } = useNetwork();
  const local = usePublicDirectory();
  const [limit, counter] = useCounter(50, { min: 50, max: Number.MAX_SAFE_INTEGER });
  const loaded = useLiveQuery((q) =>
    local.directory
      ? q
          .from({ study: local.directory.research })
          .orderBy(({ study }) => study.createdAt, "desc")
          .limit(limit)
      : undefined,
  );
  const remote = usePaginatedQuery(api.projects.publicPage, local.failed ? {} : "skip", {
    initialNumItems: 50,
  });
  const search = useForm({ initialValues: { query: "" } });
  const query = search.values.query.trim().toLocaleLowerCase();
  const rows = (local.directory ? loaded.data : remote.results)?.filter((row) =>
    [row.title, row.summary, row.topic, row.country, row.organization]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  const more = useMutation({
    mutationKey: ["research-loadmore"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (local.failed) remote.loadMore(50);
      else counter.set(limit + 50);
    },
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
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/d">{t`На главную`}</Anchor>
        <Title>{t`Открытые исследования`}</Title>
        <Text>{t`Опубликованные исследования организаций. Рабочие протоколы и данные пациентов не публикуются.`}</Text>
        <TextInput
          label={t`Поиск среди загруженных исследований`}
          {...search.getInputProps("query")}
        />
        {((!local.failed && !loaded.isReady) || (local.failed && remote.isLoading)) && (
          <Loader aria-label={t`Загрузка`} />
        )}
        {!online && !loaded.isReady && (
          <Alert>{t`Для первой загрузки каталога нужен интернет.`}</Alert>
        )}
        {local.failed && (
          <Alert>{t`Локальное хранилище недоступно. Каталог работает только при подключении к интернету.`}</Alert>
        )}
        {rows?.length === 0 && (loaded.isReady || (local.failed && !remote.isLoading)) && (
          <Text>{t`Подходящих записей пока нет.`}</Text>
        )}
        <SimpleGrid cols={2}>
          {rows?.map((row) => (
            <Paper key={row.id} withBorder p="sm">
              <Stack gap="sm">
                <Title order={2}>
                  <Anchor
                    renderRoot={(props) => (
                      <Link {...props} to="/d/research/$id" params={{ id: row.id }} />
                    )}
                  >
                    {row.title}
                  </Anchor>
                </Title>
                <Group>
                  <Badge>{kinds[row.kind]}</Badge>
                  <Badge variant="light">
                    {row.status === "recruiting" && row.recruitmentUntil <= Date.now()
                      ? t`Набор приостановлен`
                      : stages[row.status]}
                  </Badge>
                </Group>
                <Text>{row.summary}</Text>
                <Text>{row.topic}</Text>
                <Text>
                  {row.organization} · {row.country}
                </Text>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
        {((local.directory && (loaded.data?.length ?? 0) >= limit) ||
          (local.failed && remote.status === "CanLoadMore")) && (
          <Button
            loading={more.isPending || remote.status === "LoadingMore"}
            disabled={!online}
            onClick={() => more.mutate()}
          >{t`Загрузить ещё исследования`}</Button>
        )}
      </Stack>
    </Container>
  );
}
