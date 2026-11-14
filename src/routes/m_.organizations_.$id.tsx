import { useLingui } from "@lingui/react/macro";
import { Alert, Anchor, Badge, Container, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { usePublicDirectory } from "@/src/lib/use-public-directory";

export const Route = createFileRoute("/m_/organizations_/$id")({ component: Organization });
function Organization() {
  const { t } = useLingui();
  const { id } = Route.useParams();
  const { online } = useNetwork();
  const local = usePublicDirectory({ organizationId: id });
  const downloaded = useLiveQuery(() => local.directory?.organizationDetails);
  const remote = useQuery(api.organizations.publicDetails, local.failed ? { id } : "skip");
  const organization = local.directory ? downloaded.data?.[0] : remote;
  const loading = !local.failed ? !downloaded.isReady : remote === undefined;
  const kinds = {
    clinic: t`Поликлиника`,
    university: t`Университет`,
    hospital: t`Больница`,
    laboratory: t`Лаборатория`,
  };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/m/organizations">{t`Все организации`}</Anchor>
        <Title>{t`Страница организации`}</Title>
        {loading && <Loader aria-label={t`Загрузка`} />}
        {!loading && online && !organization && (
          <Alert>{t`Организация не найдена или не опубликована.`}</Alert>
        )}
        {!online && !organization && (
          <Alert>{t`Страница не сохранена на устройстве. Подключитесь к интернету для загрузки.`}</Alert>
        )}
        {!online && organization && (
          <Alert>{t`Сохранённая информация может отличаться от актуальной. Обновления загрузятся после подключения.`}</Alert>
        )}
        {local.failed && (
          <Alert>{t`Локальное хранилище недоступно. Каталог работает только при подключении к интернету.`}</Alert>
        )}
        {organization && (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Title order={2}>{organization.name}</Title>
              <Badge>{kinds[organization.kind]}</Badge>
              <Text>
                {organization.country} · {organization.city}
              </Text>
              <Text>{organization.description}</Text>
            </Stack>
          </Paper>
        )}
        <Anchor component={Link} to="/m/research">{t`Открытые исследования`}</Anchor>
        <Text>{t`Публичные сведения организации.`}</Text>
      </Stack>
    </Container>
  );
}
