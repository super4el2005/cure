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
export const Route = createFileRoute("/d_/organizations")({ component: Directory });
function Directory() {
  const { t } = useLingui();
  const mounted = useMounted();
  const local = usePublicDirectory();
  const downloaded = useLiveQuery(() => local.directory?.organizations);
  const search = useForm({ initialValues: { query: "" } });
  const directory = useQuery<FunctionReturnType<typeof api.organizations.directory>>({
    queryKey: convexQuery(api.organizations.directory, {}).queryKey,
    enabled: mounted && local.failed,
  });
  const query = search.values.query.trim().toLocaleLowerCase();
  const rows = (local.directory ? downloaded.data : directory.data)?.filter((row) =>
    [row.name, row.country, row.city, row.description]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/d">{t`На главную`}</Anchor>
        <Title>{t`Организации`}</Title>
        <Text>{t`Поликлиники, больницы, университеты и лаборатории, открытые для сотрудничества.`}</Text>
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
        <SimpleGrid cols={2}>
          {rows?.map((row) => (
            <Paper key={row.id} withBorder p="md">
              <Stack>
                <Title order={2}>{row.name}</Title>
                <Badge>
                  {
                    {
                      clinic: t`Поликлиника`,
                      university: t`Университет`,
                      hospital: t`Больница`,
                      laboratory: t`Лаборатория`,
                    }[row.kind]
                  }
                </Badge>
                <Text>
                  {row.country} · {row.city}
                </Text>
                <Text>{row.description}</Text>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
