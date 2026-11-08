import { convexQuery } from "@convex-dev/react-query";
import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvex, useConvexAuth } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import { authClient } from "@/src/lib/auth-client";
export const Route = createFileRoute("/m_/profile")({ component: Profile });
function Profile() {
  const { t } = useLingui();
  const convex = useConvex();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const queryClient = useQueryClient();
  const [editing, editor] = useDisclosure(false);
  const details = useQuery<FunctionReturnType<typeof api.profiles.mine>>({
    queryKey: convexQuery(api.profiles.mine, {}).queryKey,
    enabled: isAuthenticated,
  });
  const form = useForm({
    initialValues: {
      actorId: "",
      displayName: "",
      profession: "researcher" as "doctor" | "researcher",
      specialty: "",
      interests: "",
      languages: "",
      bio: "",
      published: false,
    },
    validate: { displayName: (value) => (value.trim() ? null : t`Укажите имя`) },
  });
  const signIn = useMutation({
    mutationKey: ["authentication"],
    retry: false,
    mutationFn: async () => {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.href,
      });
      if (result.error) throw new Error("SIGN_IN_FAILED");
    },
  });
  const save = useMutation({
    mutationKey: ["profile-save"],
    retry: false,
    mutationFn: async (input: typeof form.values) =>
      convex.mutation(api.profiles.save, {
        ...input,
        interests: input.interests
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        languages: input.languages
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: convexQuery(api.profiles.mine, {}).queryKey,
      });
      editor.close();
    },
  });
  const profile = details.data?.profile;
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m">{t`На главную`}</Anchor>
        <Title>{t`Мой профессиональный профиль`}</Title>
        {isLoading && <Text>{t`Проверяем сессию…`}</Text>}
        {!isLoading && !isAuthenticated && (
          <Stack>
            <Text>{t`Войдите, чтобы создать или открыть свой профиль.`}</Text>
            <Button
              onClick={() => signIn.mutate()}
              loading={signIn.isPending}
            >{t`Войти через Google`}</Button>
          </Stack>
        )}
        {(signIn.isError || details.isError || save.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте подключение и повторите попытку.`}</Alert>
        )}
        {isAuthenticated && details.isSuccess && (
          <>
            <Paper withBorder p="md">
              <Stack>
                <Title order={2}>{profile?.displayName ?? t`Профиль ещё не заполнен`}</Title>
                <Badge>
                  {profile?.verified
                    ? t`Квалификация подтверждена`
                    : t`Требуется подтверждение квалификации`}
                </Badge>
                <Text>{profile?.specialty}</Text>
                <Text>{profile?.bio}</Text>
                <Text>{t`Самостоятельный выбор профессии не предоставляет доступ к пациентам. Права выдаются после проверки организации.`}</Text>
                <Button
                  onClick={() => {
                    form.setValues(
                      profile
                        ? {
                            actorId: details.data!.userId,
                            displayName: profile.displayName,
                            profession: profile.profession,
                            specialty: profile.specialty,
                            interests: profile.interests.join(", "),
                            languages: profile.languages.join(", "),
                            bio: profile.bio,
                            published: profile.published,
                          }
                        : { ...form.getInitialValues(), actorId: details.data!.userId },
                    );
                    editor.open();
                  }}
                >{t`Редактировать профиль`}</Button>
              </Stack>
            </Paper>
            {editing && form.values.actorId === details.data.userId && (
              <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
                <Stack>
                  <TextInput
                    label={t`Имя`}
                    required
                    maxLength={150}
                    {...form.getInputProps("displayName")}
                  />
                  <NativeSelect
                    label={t`Профессия`}
                    disabled={Boolean(profile?.verified)}
                    data={[
                      { value: "doctor", label: t`Врач` },
                      { value: "researcher", label: t`Исследователь` },
                    ]}
                    {...form.getInputProps("profession")}
                  />
                  <TextInput
                    label={t`Специализация`}
                    maxLength={200}
                    {...form.getInputProps("specialty")}
                  />
                  <TextInput
                    label={t`Научные интересы через запятую`}
                    {...form.getInputProps("interests")}
                  />
                  <TextInput label={t`Языки через запятую`} {...form.getInputProps("languages")} />
                  <Textarea label={t`О себе`} maxLength={3000} {...form.getInputProps("bio")} />
                  <Checkbox
                    label={t`Публиковать профиль после подтверждения квалификации`}
                    {...form.getInputProps("published", { type: "checkbox" })}
                  />
                  <Group>
                    <Button type="submit" loading={save.isPending}>{t`Сохранить профиль`}</Button>
                    <Button variant="default" onClick={editor.close}>{t`Отмена`}</Button>
                  </Group>
                </Stack>
              </form>
            )}
            <Title order={2}>{t`Мои организации`}</Title>
            {details.data.memberships.length === 0 && (
              <Text>{t`Подтверждённых организаций пока нет.`}</Text>
            )}
            {details.data.memberships.map((m) => (
              <Paper withBorder p="md" key={m._id}>
                <Stack>
                  <Text>{m.organization?.name}</Text>
                  <Badge>
                    {
                      { doctor: t`Врач`, researcher: t`Исследователь`, admin: t`Администратор` }[
                        m.role
                      ]
                    }
                  </Badge>
                </Stack>
              </Paper>
            ))}
          </>
        )}
      </Stack>
    </Container>
  );
}
