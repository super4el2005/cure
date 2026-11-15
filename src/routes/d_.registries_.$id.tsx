import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  List,
  Modal,
  Paper,
  PasswordInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";

import { registryIndicators, registryValueText } from "@/src/lib/registry-data";
import type { DeidentifiedRegistryRow } from "@/src/lib/registry-data";
import { useRegistry } from "@/src/lib/use-registry";

export const Route = createFileRoute("/d_/registries_/$id")({ component: RegistryData });
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
    queriesFeed,
    raiseQuery,
    resolveQuery,
    queryParticipants,
    canRead,
    loading,
  } = useRegistry(id);
  const indicators = latest ? registryIndicators(latest.definition) : [];
  const valueLabels = { yes: t`Да`, no: t`Нет` };
  const [raising, raiseDialog] = useDisclosure(false);
  const raiseForm = useForm({
    initialValues: {
      participantCode: "",
      occurredOn: "",
      formVersion: 1,
      fieldId: null as string | null,
      text: "",
    },
    validate: { text: (value) => (value.trim() ? null : t`Опишите, что нужно уточнить`) },
  });
  const startRaise = (observation: DeidentifiedRegistryRow) => {
    raiseForm.setValues({
      participantCode: observation.participantCode,
      occurredOn: observation.occurredOn,
      formVersion: observation.formVersion,
      fieldId: null,
      text: "",
    });
    raiseForm.clearErrors();
    raiseDialog.open();
  };
  const queryRows = queriesFeed.data ?? [];
  const fieldLabels = new Map(
    (researcherFeed.data?.fields ?? []).map((field) => [field.id, field.label]),
  );
  const indicatorLabels = new Map(indicators.map((field) => [field.id, field.label]));
  const queryStatuses = {
    open: t`Открыт`,
    resolved: t`Отвечен`,
    dismissed: t`Отклонён`,
  } as const;
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Modal opened={raising} onClose={raiseDialog.close} title={t`Запрос на уточнение данных`}>
          <form
            onSubmit={raiseForm.onSubmit((values) =>
              raiseQuery.mutate(values, {
                onSuccess: () => {
                  raiseDialog.close();
                  raiseForm.reset();
                },
              }),
            )}
          >
            <Stack gap="sm">
              <Text size="sm">
                {t`Участник`} {raiseForm.values.participantCode}
                {", "}
                {raiseForm.values.occurredOn &&
                  i18n.date(`${raiseForm.values.occurredOn}T00:00:00Z`, {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  })}
              </Text>
              <Select
                clearable
                label={t`Показатель`}
                data={(researcherFeed.data?.fields ?? []).map((field) => ({
                  value: field.id,
                  label: field.label,
                }))}
                {...raiseForm.getInputProps("fieldId")}
              />
              <Textarea
                required
                label={t`Что нужно уточнить`}
                description={t`Запрос не даёт права изменять карту пациента и не раскрывает личные данные участника`}
                maxLength={2000}
                {...raiseForm.getInputProps("text")}
              />
              {raiseQuery.isError && (
                <Alert color="red">{t`Не удалось отправить запрос. Проверьте сеть и повторите попытку.`}</Alert>
              )}
              <Button type="submit" loading={raiseQuery.isPending}>{t`Отправить запрос`}</Button>
            </Stack>
          </form>
        </Modal>
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
                                  {t`источник — форма, версия`} {observation.formVersion}{" "}
                                  <Button
                                    variant="subtle"
                                    size="compact-sm"
                                    onClick={() => startRaise(observation)}
                                  >{t`Запросить уточнение`}</Button>
                                </List.Item>
                              ))}
                            </List>
                          </Stack>
                        </Paper>
                      ))
                    )}
                    <Title order={2}>{t`Мои запросы на уточнение`}</Title>
                    {queriesFeed.isError && (
                      <Alert color="red">{t`Не удалось загрузить запросы. Повторите попытку позже.`}</Alert>
                    )}
                    {queryRows.length === 0 ? (
                      <Text>{t`Запросов пока нет.`}</Text>
                    ) : (
                      queryRows.map((row) => (
                        <Paper withBorder p="sm" key={row.clientId}>
                          <Stack gap="xs">
                            <Group>
                              <Badge color={row.status === "open" ? "blue" : "gray"}>
                                {queryStatuses[row.status]}
                              </Badge>
                              <Text size="sm">
                                {t`Участник`} {row.participantCode}
                                {", "}
                                {i18n.date(`${row.occurredOn}T00:00:00Z`, {
                                  dateStyle: "medium",
                                  timeZone: "UTC",
                                })}
                                {row.fieldId && fieldLabels.get(row.fieldId)
                                  ? `, ${fieldLabels.get(row.fieldId)}`
                                  : ""}
                              </Text>
                            </Group>
                            <Text size="sm">{row.text}</Text>
                            {row.resolution && (
                              <Text size="sm">
                                {t`Ответ врача:`} {row.resolution}
                              </Text>
                            )}
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
                            to="/d/projects/$id/forms"
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
                                  to="/d/patients/$id/forms"
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
                    {latest && registry && (
                      <>
                        <Title order={2}>{t`Запросы на уточнение данных`}</Title>
                        {queriesFeed.isError && (
                          <Alert color="red">{t`Не удалось загрузить запросы. Повторите попытку позже.`}</Alert>
                        )}
                        {resolveQuery.isError && (
                          <Alert color="red">{t`Не удалось сохранить ответ. Проверьте сеть и повторите попытку.`}</Alert>
                        )}
                        {queryRows.length === 0 ? (
                          <Text>{t`Запросов от участников проекта пока нет.`}</Text>
                        ) : (
                          queryRows.map((row) => (
                            <ResolveRow
                              key={row.clientId}
                              queryRow={row}
                              participant={
                                names.get(queryParticipants.get(row.participantCode) ?? "") ??
                                row.participantCode
                              }
                              indicator={(row.fieldId && indicatorLabels.get(row.fieldId)) || null}
                              resolveQuery={resolveQuery}
                            />
                          ))
                        )}
                      </>
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
function ResolveRow({
  queryRow,
  participant,
  indicator,
  resolveQuery,
}: {
  queryRow: {
    clientId: string;
    participantCode: string;
    occurredOn: string;
    formVersion: number;
    fieldId: string | null;
    text: string;
    status: "open" | "resolved" | "dismissed";
    resolution: string;
  };
  participant: string;
  indicator: string | null;
  resolveQuery: {
    mutate: (
      input: { clientId: string; status: "resolved" | "dismissed"; resolution: string },
      options?: { onSuccess?: () => void },
    ) => void;
    isPending: boolean;
  };
}) {
  const { t, i18n } = useLingui();
  const resolveForm = useForm({ initialValues: { resolution: "" } });
  const statuses = {
    open: t`Открыт`,
    resolved: t`Отвечен`,
    dismissed: t`Отклонён`,
  } as const;
  const submit = (status: "resolved" | "dismissed") =>
    resolveQuery.mutate(
      { clientId: queryRow.clientId, status, resolution: resolveForm.values.resolution },
      { onSuccess: () => resolveForm.reset() },
    );
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group>
          <Badge color={queryRow.status === "open" ? "blue" : "gray"}>
            {statuses[queryRow.status]}
          </Badge>
          <Text size="sm">
            {participant}
            {", "}
            {i18n.date(`${queryRow.occurredOn}T00:00:00Z`, {
              dateStyle: "medium",
              timeZone: "UTC",
            })}
            {", "}
            {t`версия формы`} {queryRow.formVersion}
            {indicator ? `, ${indicator}` : ""}
          </Text>
        </Group>
        <Text size="sm">{queryRow.text}</Text>
        {queryRow.status === "open" ? (
          <>
            <Textarea
              label={t`Ответ врача`}
              maxLength={2000}
              {...resolveForm.getInputProps("resolution")}
            />
            <Group>
              <Button
                loading={resolveQuery.isPending}
                disabled={!resolveForm.values.resolution.trim()}
                onClick={() => submit("resolved")}
              >{t`Ответить`}</Button>
              <Button
                variant="default"
                loading={resolveQuery.isPending}
                onClick={() => submit("dismissed")}
              >{t`Отклонить`}</Button>
            </Group>
          </>
        ) : (
          queryRow.resolution && (
            <Text size="sm">
              {t`Ответ врача:`} {queryRow.resolution}
            </Text>
          )
        )}
      </Stack>
    </Paper>
  );
}
