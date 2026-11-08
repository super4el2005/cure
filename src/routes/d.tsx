import { useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  List,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { authClient } from "@/src/lib/auth-client";
export const Route = createFileRoute("/d")({ component: Home });
function Home() {
  const { t } = useLingui();
  const signIn = useMutation({
    mutationKey: ["authentication"],
    retry: false,
    mutationFn: async () => {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: new URL("/d/profile", window.location.origin).href,
        errorCallbackURL: new URL("/auth/error", window.location.origin).href,
      });
      if (result.error) throw new Error("SIGN_IN_FAILED");
    },
  });
  return (
    <Container component="main" data-page="desktop" py="xl">
      <Stack>
        <Badge>Cure</Badge>
        <Title>{t`Врачи и исследователи — вместе`}</Title>
        <Text size="lg">{t`Связываем клиническую практику и университетскую науку для совместных исследований.`}</Text>
        <Group>
          <Button
            loading={signIn.isPending}
            onClick={() => signIn.mutate()}
          >{t`Войти через Google`}</Button>
          <Anchor component={Link} to="/d/profile">{t`Мой профиль`}</Anchor>
        </Group>
        {signIn.isError && <Text role="alert">{t`Не удалось войти. Повторите попытку.`}</Text>}
        <SimpleGrid cols={2}>
          <Paper withBorder p="md">
            <Stack>
              <Title order={2}>{t`Врачам`}</Title>
              <List>
                <List.Item>{t`Ведение данных пациентов в рамках предоставленного доступа.`}</List.Item>
                <List.Item>{t`Поиск исследователей для клинических задач.`}</List.Item>
                <List.Item>{t`Участие в совместных исследованиях.`}</List.Item>
              </List>
              <Anchor component={Link} to="/d/specialists">{t`Найти специалиста`}</Anchor>
            </Stack>
          </Paper>
          <Paper withBorder p="md">
            <Stack>
              <Title order={2}>{t`Исследователям`}</Title>
              <List>
                <List.Item>{t`Поиск клинических партнёров и исследовательских центров.`}</List.Item>
                <List.Item>{t`Чтение разрешённых данных пациентов без изменения карт.`}</List.Item>
                <List.Item>{t`Связь научных вопросов с клинической практикой.`}</List.Item>
              </List>
              <Anchor component={Link} to="/d/organizations">{t`Найти организацию`}</Anchor>
            </Stack>
          </Paper>
        </SimpleGrid>
        <Paper withBorder p="md">
          <Stack>
            <Title order={2}>{t`Открытые каталоги`}</Title>
            <Text>{t`Просматривайте опубликованные профили и организации без входа. Данные пациентов не публикуются.`}</Text>
            <Group>
              <Anchor component={Link} to="/d/specialists">{t`Специалисты`}</Anchor>
              <Anchor component={Link} to="/d/organizations">{t`Организации`}</Anchor>
              <Anchor component={Link} to="/d/tools">{t`Медицинские справочники и AI`}</Anchor>
            </Group>
          </Stack>
        </Paper>
      </Stack>
    </Container>
  );
}
