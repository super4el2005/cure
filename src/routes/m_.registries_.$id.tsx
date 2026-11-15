import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  List,
  Paper,
  PasswordInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

import { registryIndicators, registryValueText } from "@/src/lib/registry-data";
import { useRegistry } from "@/src/lib/use-registry";

export const Route = createFileRoute("/m_/registries_/$id")({ component: RegistryData });
function RegistryData() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    userId,
    online,
    workspace,
    opened,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    status,
    family,
    latest,
    registry,
    project,
    series,
    names,
    researcherFeed,
    researcherSeries,
    canRead,
    loading,
  } = useRegistry(id);
  const indicators = latest ? registryIndicators(latest.definition) : [];
  const valueLabels = { yes: t`Да`, no: t`Нет` };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Title>{t`Данные регистра`}</Title>
        {!userId && (
          <Alert>{t`Войдите и подтвердите принадлежность к организации, чтобы работать с пациентами.`}</Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="sm">
            <form
              onSubmit={unlockForm.onSubmit((values) =>
                unlock.mutate({ organizationId: values.organizationId }),
              )}
            >
              <Stack gap="sm">
                <Select
                  allowDeselect={false}
                  label={t`Организация`}
                  data={[{ value: "", label: t`Выберите организацию` }, ...options]}
                  {...unlockForm.getInputProps("organizationId")}
                />
                <PasswordInput
                  label={t`Парольная фраза локального хранилища`}
                  autoComplete="off"
                  {...unlockForm.getInputProps("passphrase")}
                />
                {!headers.data?.some(
                  (h) => h.organizationId === unlockForm.values.organizationId,
                ) && (
                  <PasswordInput
                    label={t`Повторите парольную фразу`}
                    autoComplete="off"
                    {...unlockForm.getInputProps("confirmation")}
                  />
                )}
                <Button
                  type="submit"
                  loading={unlock.isPending}
                  disabled={options.length === 0}
                >{t`Открыть рабочее пространство`}</Button>
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError || lock.isError || resume.isError) && (
          <Alert color="red">{t`Не удалось открыть рабочее пространство. Проверьте парольную фразу и повторите попытку.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Button
                variant="default"
                loading={lock.isPending}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
            </Group>
            {!status.data?.online && (
              <Alert>
                {t`Синхронизация приостановлена. Нужны сеть и подтверждённая сессия того же пользователя.`}
                <Button
                  variant="default"
                  loading={resume.isPending}
                  disabled={!online}
                  onClick={() => resume.mutate()}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            {!canRead ? (
              <>
                {researcherFeed.isPending && <Text>{t`Загрузка данных регистра…`}</Text>}
                {researcherFeed.isError && (
                  <Alert color="red">{t`Не удалось загрузить данные регистра. Проверьте членство в проекте и повторите попытку.`}</Alert>
                )}
                {researcherFeed.isSuccess && (
                  <>
                    <Group>
                      <Title order={2}>{researcherFeed.data.title}</Title>
                      <Badge>{researcherFeed.data.registry.code}</Badge>
                      <Badge variant="light">
                        {t`Версия формы`} {researcherFeed.data.version}
                      </Badge>
                    </Group>
                    <Alert>{t`Показаны обезличенные записи участников с действующим согласием на участие в исследовании. Наблюдения одного участника сопоставляются между визитами по коду участника; личные данные, авторы записей и примечания не раскрываются. Чтение требует сети и не сохраняется на устройстве.`}</Alert>
                    {researcherSeries.length === 0 ? (
                      <Text>{t`Окончательных ответов участников с действующим согласием пока нет.`}</Text>
                    ) : (
                      researcherSeries.map((group) => (
                        <Paper withBorder p="sm" key={group.participantCode}>
                          <Stack gap="sm">
                            <Title order={3}>
                              {t`Участник`} {group.participantCode}
                            </Title>
                            <ScrollArea>
                              <Table>
                                <Table.Thead>
                                  <Table.Tr>
                                    <Table.Th>{t`Показатель`}</Table.Th>
                                    {group.observations.map((observation) => (
                                      <Table.Th key={observation.observationId}>
                                        {i18n.date(`${observation.occurredOn}T00:00:00Z`, {
                                          dateStyle: "medium",
                                          timeZone: "UTC",
                                        })}
                                      </Table.Th>
                                    ))}
                                  </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                  {researcherFeed.data.fields.map((field) => (
                                    <Table.Tr key={field.id}>
                                      <Table.Td>{field.label}</Table.Td>
                                      {group.observations.map((observation) => (
                                        <Table.Td key={observation.observationId}>
                                          {registryValueText(
                                            field,
                                            observation.answers[field.id],
                                            valueLabels,
                                          ) || "—"}
                                        </Table.Td>
                                      ))}
                                    </Table.Tr>
                                  ))}
                                </Table.Tbody>
                              </Table>
                            </ScrollArea>
                            <List size="sm">
                              {group.observations.map((observation) => (
                                <List.Item key={observation.observationId}>
                                  {t`Наблюдение от`}{" "}
                                  {i18n.date(`${observation.occurredOn}T00:00:00Z`, {
                                    dateStyle: "medium",
                                    timeZone: "UTC",
                                  })}
                                  {", "}
                                  {t`источник — форма, версия`} {observation.formVersion}
                                </List.Item>
                              ))}
                            </List>
                          </Stack>
                        </Paper>
                      ))
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                {loading && <Text>{t`Загрузка локальных данных…`}</Text>}
                {!loading && family.length === 0 && (
                  <Alert>{t`Регистр не найден. Шаблон должен хотя бы раз синхронизироваться с сервером в исследовательском пространстве.`}</Alert>
                )}
                {!loading && latest && !registry && (
                  <Alert>{t`Эта форма не отмечена как регистр в последней версии. Отметьте реестровые показатели в конструкторе форм проекта.`}</Alert>
                )}
                {!loading && latest && registry && (
                  <>
                    <Group>
                      <Title order={2}>{latest.definition.title}</Title>
                      <Badge>{registry.code}</Badge>
                      <Badge variant="light">
                        {t`Версия формы`} {latest.version}
                      </Badge>
                    </Group>
                    {project && (
                      <Anchor
                        renderRoot={(props) => (
                          <Link
                            {...props}
                            to="/m/projects/$id/forms"
                            params={{ id: project.clientId }}
                          />
                        )}
                      >
                        {project.title}
                      </Anchor>
                    )}
                    <Alert>{t`Показаны окончательные ответы по реестровым показателям в хронологии каждого пациента. Ввод и исправление данных выполняются в карте пациента на странице опросников; источник, автор, время и способ получения указаны под каждой таблицей.`}</Alert>
                    {series.length === 0 ? (
                      <Text>{t`Окончательных ответов по этому регистру пока нет.`}</Text>
                    ) : (
                      series.map((group) => (
                        <Paper withBorder p="sm" key={group.patientClientId}>
                          <Stack gap="sm">
                            <Anchor
                              renderRoot={(props) => (
                                <Link
                                  {...props}
                                  to="/m/patients/$id/forms"
                                  params={{ id: group.patientClientId }}
                                />
                              )}
                            >
                              {names.get(group.patientClientId) ?? group.patientClientId}
                            </Anchor>
                            <ScrollArea>
                              <Table>
                                <Table.Thead>
                                  <Table.Tr>
                                    <Table.Th>{t`Показатель`}</Table.Th>
                                    {group.observations.map((observation) => (
                                      <Table.Th key={observation.clientId}>
                                        {i18n.date(`${observation.occurredOn}T00:00:00Z`, {
                                          dateStyle: "medium",
                                          timeZone: "UTC",
                                        })}
                                      </Table.Th>
                                    ))}
                                  </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                  {indicators.map((indicator) => (
                                    <Table.Tr key={indicator.id}>
                                      <Table.Td>{indicator.label}</Table.Td>
                                      {group.observations.map((observation) => {
                                        const snapshotField =
                                          observation.definition.fields.find(
                                            (field) => field.id === indicator.id,
                                          ) ?? indicator;
                                        return (
                                          <Table.Td key={observation.clientId}>
                                            {registryValueText(
                                              snapshotField,
                                              observation.answers[indicator.id],
                                              valueLabels,
                                            ) || "—"}
                                          </Table.Td>
                                        );
                                      })}
                                    </Table.Tr>
                                  ))}
                                </Table.Tbody>
                              </Table>
                            </ScrollArea>
                            <List size="sm">
                              {group.observations.map((observation) => (
                                <List.Item key={observation.clientId}>
                                  {t`Наблюдение от`}{" "}
                                  {i18n.date(`${observation.occurredOn}T00:00:00Z`, {
                                    dateStyle: "medium",
                                    timeZone: "UTC",
                                  })}
                                  {": "}
                                  {t`источник — форма, версия`} {observation.formVersion}
                                  {", "}
                                  {t`автор`} {observation.updatedBy ?? "—"}
                                  {", "}
                                  {t`изменено`}{" "}
                                  {i18n.date(observation.updatedAt, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })}
                                  {", "}
                                  {t`способ — ручной ввод врачом`}
                                </List.Item>
                              ))}
                            </List>
                          </Stack>
                        </Paper>
                      ))
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
