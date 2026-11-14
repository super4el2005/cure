import { useLingui } from "@lingui/react/macro";
import { Button, Container, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/error")({
  component: AuthError,
});

function AuthError() {
  const { t } = useLingui();

  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Title order={1}>{t`Не удалось войти`}</Title>
        <Text>{t`Вход был отменён или произошла ошибка. Вернитесь на главную и попробуйте ещё раз.`}</Text>
        <Button component={Link} to="/">{t`На главную`}</Button>
      </Stack>
    </Container>
  );
}
