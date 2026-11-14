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
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMounted } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import { usePublicDirectory } from "@/src/lib/use-public-directory";
export const Route = createFileRoute("/m_/specialists")({ component: Directory });
function Directory() {
  const { t } = useLingui();
  const mounted = useMounted();
  const local = usePublicDirectory();
  const downloaded = useLiveQuery(() => local.directory?.specialists);
  const search = useForm({ initialValues: { query: "" } });
  const directory = useQuery<FunctionReturnType<typeof api.profiles.directory>>({
    queryKey: convexQuery(api.profiles.directory, {}).queryKey,
    enabled: mounted && local.failed,
  });
  const query = search.values.query.trim().toLocaleLowerCase();
  const rows = (local.directory ? downloaded.data : directory.data)?.filter((row) =>
    [row.displayName, row.specialty, row.bio, ...row.interests, ...row.languages]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/m">{t`На главную`}</Anchor>
        <Title>{t`Специалисты`}</Title>
        <Text>{t`Опубликованные профили врачей и исследователей с подтверждённой квалификацией.`}</Text>
        <TextInput label={t`Поиск`} {...search.getInputProps("query")} />
        {(directory.isFetching || (!local.failed && !downloaded.isReady)) && (
          <Loader aria-label={t`Загрузка`} />
        )}
        {directory.isError && (
          <Alert color="red">
            {t`Не удалось загрузить каталог. Проверьте подключение и повторите попытку.`}
            <Anchor
              component="button"
              onClick={() => void directory.refetch()}
            >{t`Повторить`}</Anchor>
          </Alert>
        )}
        {(directory.isSuccess || downloaded.isReady) && rows?.length === 0 && (
          <Text>{t`Подходящих записей пока нет.`}</Text>
        )}
        {local.failed && (
          <Alert>{t`Локальное хранилище недоступно. Каталог работает только при подключении к интернету.`}</Alert>
        )}
        <SimpleGrid cols={1}>
          {rows?.map((row) => (
            <Paper key={row.id} withBorder p="sm">
              <Stack gap="sm">
                <Group>
                  <Title order={2}>
                    <Anchor
                      renderRoot={(props) => (
                        <Link {...props} to="/m/specialists/$id" params={{ id: row.id }} />
                      )}
                    >
                      {row.displayName}
                    </Anchor>
                  </Title>
                  <Badge>{t`Проверен`}</Badge>
                </Group>
                <Text>{row.profession === "doctor" ? t`Врач` : t`Исследователь`}</Text>
                <Text>{row.specialty}</Text>
                <Text>{row.bio}</Text>
                <Group>
                  {row.interests.map((item) => (
                    <Badge key={item} variant="light">
                      {item}
                    </Badge>
                  ))}
                </Group>
                <Text>{row.languages.join(", ")}</Text>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
