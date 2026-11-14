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
import { useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { usePublicDirectory } from "@/src/lib/use-public-directory";

export const Route = createFileRoute("/d_/specialists_/$id")({ component: Specialist });
function Specialist() {
  const { t } = useLingui();
  const { id } = Route.useParams();
  const { online } = useNetwork();
  const local = usePublicDirectory({ specialistId: id });
  const downloaded = useLiveQuery(() => local.directory?.specialistDetails);
  const remote = useQuery(api.profiles.publicDetails, local.failed ? { id } : "skip");
  const profile = local.directory ? downloaded.data?.[0] : remote;
  const loading = !local.failed ? !downloaded.isReady : remote === undefined;
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/d/specialists">{t`Все специалисты`}</Anchor>
        <Title>{t`Профиль специалиста`}</Title>
        {loading && <Loader aria-label={t`Загрузка`} />}
        {!loading && online && !profile && (
          <Alert>{t`Профиль не найден или не опубликован.`}</Alert>
        )}
        {!online && !profile && (
          <Alert>{t`Страница не сохранена на устройстве. Подключитесь к интернету для загрузки.`}</Alert>
        )}
        {!online && profile && (
          <Alert>{t`Сохранённая информация может отличаться от актуальной. Обновления загрузятся после подключения.`}</Alert>
        )}
        {local.failed && (
          <Alert>{t`Локальное хранилище недоступно. Каталог работает только при подключении к интернету.`}</Alert>
        )}
        {profile && (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Title order={2}>{profile.displayName}</Title>
              <Group>
                <Badge>{profile.profession === "doctor" ? t`Врач` : t`Исследователь`}</Badge>
                <Badge>{t`Квалификация подтверждена`}</Badge>
              </Group>
              <Text>{profile.specialty}</Text>
              <Text>{profile.bio}</Text>
              <Title order={3}>{t`Научные интересы`}</Title>
              <Group>
                {[...new Set(profile.interests)].map((interest) => (
                  <Badge key={interest} variant="light">
                    {interest}
                  </Badge>
                ))}
              </Group>
              <Title order={3}>{t`Языки общения`}</Title>
              <Text>{profile.languages.join(", ") || t`Не указаны`}</Text>
            </Stack>
          </Paper>
        )}
        <Text>{t`Публичный профиль специалиста.`}</Text>
      </Stack>
    </Container>
  );
}
