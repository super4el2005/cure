import { useLingui } from "@lingui/react/macro";
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure, useMounted, useReducedMotion } from "@mantine/hooks";
import { Player } from "@remotion/player";
import { createFileRoute, Link, Navigate, redirect, useRouter } from "@tanstack/react-router";
import { useContext } from "react";
import { FiSun, FiMoon } from "react-icons/fi";
import { useCurrentFrame } from "remotion";

import { authClient } from "@/src/lib/auth-client";
import { saveLanguage } from "@/src/lib/language";
import { PwaInstallContext } from "@/src/lib/pwa-install";

export const Route = createFileRoute("/d")({
  beforeLoad: ({ context }) => {
    if (context.isAuthenticated) throw redirect({ to: "/d/workspace", replace: true });
  },
  component: Home,
});
function Home() {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const pwa = useContext(PwaInstallContext);
  const [instructions, dialog] = useDisclosure();
  const mounted = useMounted();
  const reducedMotion = useReducedMotion();
  const session = authClient.useSession();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  if (session.data?.user) return <Navigate to="/d/workspace" replace />;
  return (
    <Box
      component="main"
      data-page="desktop"
      h="100dvh"
      p="xl"
      display="flex"
      style={{ flexDirection: "column", overflow: "hidden" }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text fw={700} size="xl">
          Cure
        </Text>
        <Group gap="xs">
          <Select
            w={105}
            size="xs"
            aria-label={t`Язык интерфейса`}
            value={i18n.locale}
            allowDeselect={false}
            data={[
              { value: "ru", label: "Русский" },
              { value: "en", label: "English" },
            ]}
            onChange={(value) => {
              if (value === "ru" || value === "en") {
                saveLanguage(value);
                void router.invalidate().catch(() => undefined);
              }
            }}
          />
          <ActionIcon
            variant="default"
            aria-label={t`Сменить тему`}
            onClick={() => toggleColorScheme()}
          >
            {colorScheme === "dark" ? <FiSun /> : <FiMoon />}
          </ActionIcon>
        </Group>
      </Group>
      <Box
        flex={1}
        mih={0}
        display="flex"
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 40 }}
      >
        <Stack gap="sm" maw={520}>
          <Text size="xs" c="dimmed">{t`Клиническая практика × наука`}</Text>
          <Title order={1} size="h1">{t`Врачи и исследователи — вместе`}</Title>
          <Text size="lg">{t`Пациенты, исследования и аналитика — в одном рабочем пространстве.`}</Text>
          <Group gap="xs" wrap="nowrap">
            <Button
              size="sm"
              variant="default"
              loading={pwa.pending}
              onClick={() => (pwa.available ? pwa.install() : dialog.open())}
            >{t`Скачать приложение`}</Button>
            <Button size="sm" component={Link} to="/d/workspace">{t`Открыть в браузере`}</Button>
          </Group>
          <Text
            size="xs"
            c="dimmed"
          >{t`Google-вход · Работа с подготовленными данными офлайн`}</Text>
        </Stack>
        <Box w="52%" maw={720} mah="58dvh" style={{ overflow: "hidden" }}>
          <Text size="xs" c="dimmed" mb={4}>{t`Демо приложения · вымышленные данные`}</Text>
          {mounted ? (
            <Player
              component={ApplicationDemo}
              durationInFrames={450}
              compositionWidth={960}
              compositionHeight={540}
              fps={30}
              controls
              loop
              autoPlay={!reducedMotion}
              showVolumeControls={false}
              style={{ width: "100%", maxHeight: "58dvh" }}
            />
          ) : (
            <Paper withBorder p="sm">
              <Text>{t`Пациенты → Исследование → Аналитика`}</Text>
            </Paper>
          )}
        </Box>
      </Box>
      <Stack gap={4} pt="xs">
        <Text size="xs" fw={600}>{t`Примеры медицинских организаций · не партнёры Cure`}</Text>
        <Group gap="md">
          <Anchor
            size="xs"
            href="https://www.sechenov.ru/eng/"
            target="_blank"
            rel="noopener noreferrer"
          >{t`Сеченовский университет`}</Anchor>
          <Anchor
            size="xs"
            href="https://www.charite.de/en/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Charité
          </Anchor>
          <Anchor
            size="xs"
            href="https://www.mayoclinic.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Mayo Clinic
          </Anchor>
        </Group>
        <Text
          size="xs"
          c="dimmed"
        >{t`Результат демо: пациент включён в исследование, когорта подготовлена для анализа.`}</Text>
      </Stack>
      <Modal opened={instructions} onClose={dialog.close} title={t`Установка Cure`}>
        <Stack gap="sm">
          <Text size="sm">{t`В Chrome или Edge выберите «Установить приложение» в меню браузера. На iPhone: «Поделиться» → «На экран Домой».`}</Text>
          <Text size="sm">{t`Если установка недоступна, откройте приложение в браузере.`}</Text>
          <Button component={Link} to="/d/workspace">{t`Открыть в браузере`}</Button>
        </Stack>
      </Modal>
    </Box>
  );
}

// An isolated, deterministic walkthrough. No patient data, network or real mutations.
function ApplicationDemo() {
  const { t } = useLingui();
  const frame = useCurrentFrame();
  const phase = Math.min(2, Math.floor(frame / 150));
  const titles = [t`Пациенты`, t`Исследование`, t`Аналитика`];
  return (
    <Paper withBorder h={540} p="md">
      <Stack gap="md">
        <Group justify="space-between">
          <Text fw={700}>Cure</Text>
          <Badge variant="light">{t`Демонстрация`}</Badge>
        </Group>
        <Group align="flex-start" wrap="nowrap">
          <Stack w={170} gap="xs">
            {titles.map((title, index) => (
              <Button key={title} variant={index === phase ? "light" : "subtle"} justify="start">
                {title}
              </Button>
            ))}
          </Stack>
          <Stack flex={1} gap="md">
            <Title order={2}>{titles[phase]}</Title>
            {phase === 0 && (
              <>
                <Text>{t`Карта пациента · Демо-001`}</Text>
                <Table withTableBorder>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td>{t`Диагноз`}</Table.Td>
                      <Table.Td>J45</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>{t`Согласие`}</Table.Td>
                      <Table.Td>{t`Зарегистрировано`}</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>{t`Визит`}</Table.Td>
                      <Table.Td>{t`Запланирован`}</Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
                <Badge color="green">{t`Сохранено на устройстве`}</Badge>
              </>
            )}
            {phase === 1 && (
              <>
                <Text fw={600}>{t`Наблюдение пациентов с астмой`}</Text>
                <Text>{t`Демо-001 включён в исследование`}</Text>
                <Progress value={65} />
                <Text size="sm">{t`Набор: 13 из 20 участников · пример`}</Text>
                <Badge>{t`Согласие проверено`}</Badge>
              </>
            )}
            {phase === 2 && (
              <>
                <Text>{t`Сравнение двух когорт`}</Text>
                <Table withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t`Когорта`}</Table.Th>
                      <Table.Th>n</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td>A</Table.Td>
                      <Table.Td>8</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>B</Table.Td>
                      <Table.Td>5</Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
                <Text size="sm">{t`Таблица для анализа подготовлена`}</Text>
                <Badge variant="light">{t`Демонстрационные значения`}</Badge>
              </>
            )}
          </Stack>
        </Group>
        <Progress value={((frame % 150) / 150) * 100} size="xs" />
      </Stack>
    </Paper>
  );
}
