import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { createFileRoute, Link } from "@tanstack/react-router";

import { clinicalHistoryContent } from "@/src/lib/clinical-history-content";
import { patientHistoryContent } from "@/src/lib/patient-history-content";
import { useClinicalHistory } from "@/src/lib/use-clinical-history";

export const Route = createFileRoute("/d_/patients_/$id_/history")({ component: ClinicalHistory });
function ClinicalHistory() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    workspace,
    opened,
    userId,
    online,
    status,
    rows,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    cardVersions,
    cardHistory,
    versions,
    current,
    patients,
    history,
    unarchived,
    names,
  } = useClinicalHistory(id);
  const filters = useForm({ initialValues: { query: "", record: "" } });
  const patient = rows.find((row) => row.clientId === id);
  const display = history.map((record) => ({
    ...record,
    content: clinicalHistoryContent(record.payload, i18n, names),
  }));
  const currentDisplay = unarchived.flatMap((record) =>
    record.payload
      ? [
          {
            ...record,
            recordClientId: record.clientId,
            content: clinicalHistoryContent(record.payload, i18n, names),
          },
        ]
      : [],
  );
  const matches = (record: {
    recordClientId: string;
    content: ReturnType<typeof clinicalHistoryContent>;
  }) =>
    (!filters.values.record || record.recordClientId === filters.values.record) &&
    `${record.content.title} ${record.content.rows.flat().join(" ")}`
      .toLocaleLowerCase(i18n.locale)
      .includes(filters.values.query.trim().toLocaleLowerCase(i18n.locale));
  const choices = [
    ...new Map(
      [...display.toReversed(), ...currentDisplay].map((record) => [
        record.recordClientId,
        {
          value: record.recordClientId,
          label: `${record.content.title} — ${record.payload?.occurredOn ?? ""}`,
        },
      ]),
    ).values(),
  ];
  const selected = display.filter(matches);
  const selectedCurrent = currentDisplay.filter(matches);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor
          renderRoot={(props) => <Link {...props} to="/d/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`История карты и клинических записей`}</Title>
        <Text>{t`Сохранённые редакции анамнеза, терапии, обследований, визитов и исследовательских записей. Это история содержимого, а не только список действий.`}</Text>
        {!userId && (
          <Alert>{t`Войдите и подтвердите принадлежность к организации, чтобы работать с пациентами.`}</Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="md">
            <form
              onSubmit={unlockForm.onSubmit((values) =>
                unlock.mutate({ organizationId: values.organizationId }),
              )}
            >
              <Stack>
                <Text>{t`Рабочее пространство защищено парольной фразой. Она не отправляется на сервер. Сохраните её: без неё локальные данные и неотправленные изменения восстановить нельзя.`}</Text>
                <NativeSelect
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
                  (row) => row.organizationId === unlockForm.values.organizationId,
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
                  disabled={!options.length}
                >{t`Открыть рабочее пространство`}</Button>
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError || resume.isError || lock.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Badge>
                {status.data?.online ? t`Синхронизация подключена` : t`Локальная работа`}
              </Badge>
              <Button
                variant="default"
                loading={resume.isPending}
                disabled={!online}
                onClick={() => resume.mutate()}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                loading={lock.isPending}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {opened?.role !== "doctor" ? (
              <Alert>{t`История клинического содержимого доступна только врачу клиники. Согласие на пол и диагнозы не открывает эти записи исследователю.`}</Alert>
            ) : !patients.isReady || !current.isReady ? (
              <Text>{t`Загрузка локальных данных…`}</Text>
            ) : !patient ? (
              <Alert>{t`Пациент недоступен или удалён.`}</Alert>
            ) : (
              <>
                <Title order={2}>{patient.fullName}</Title>
                <Alert>{t`Удалённые записи и записи удалённого пациента здесь не показываются. История, которая была утрачена до подключения версий, не восстанавливается задним числом.`}</Alert>
                {(!versions.isReady ||
                  !workspace.clinicalVersions.has(workspace.versionSnapshotId)) && (
                  <Alert color="yellow">{t`Серверная история ещё не подготовлена на устройстве. Показаны только доступные локальные редакции и текущие записи.`}</Alert>
                )}

                <Title order={2}>{t`Редакции карты пациента`}</Title>
                <Alert>{t`Исторические сведения не восстанавливают согласие или доступ исследователя. Действующие разрешения определяются текущей картой и выданным доступом.`}</Alert>
                {(!cardVersions.isReady ||
                  !workspace.patientVersions.has(workspace.patientVersionSnapshotId)) && (
                  <Alert color="yellow">{t`История карты ещё не подготовлена на устройстве. Новые локальные редакции сохраняются вместе с очередью; ранее не загруженные сведения требуют сети.`}</Alert>
                )}
                <Accordion multiple>
                  {cardHistory.map((record) => (
                    <Accordion.Item value={record.clientId} key={record.clientId}>
                      <Accordion.Control>
                        {t`Карта пациента`} — {t`Редакция`} {record.revision} —{" "}
                        {i18n.date(new Date(record.recordedAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack>
                          <Text>
                            {t`Автор записи`}:{" "}
                            {names.get(record.recordedBy) ??
                              (record.recordedBy || t`Автор не указан`)}
                          </Text>
                          <Badge>
                            {record.confirmed
                              ? t`Подтверждено сервером`
                              : t`Локальная редакция; ожидает подтверждения`}
                          </Badge>
                          {patientHistoryContent(record.values, i18n, names).map(
                            ([label, value], index) => (
                              <Stack key={index}>
                                <Text fw={600}>{label}</Text>
                                <Text>{value}</Text>
                              </Stack>
                            ),
                          )}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
                {!cardHistory.some((record) => record.revision === patient.revision) && (
                  <Paper withBorder p="md">
                    <Stack>
                      <Title order={3}>{t`Текущая карта без загруженной архивной редакции`}</Title>
                      <Text>{t`Показана текущая запись. Архивная редакция появится после подготовки истории или следующего изменения.`}</Text>
                      {patientHistoryContent(patient, i18n, names).map(([label, value], index) => (
                        <Stack key={index}>
                          <Text fw={600}>{label}</Text>
                          <Text>{value}</Text>
                        </Stack>
                      ))}
                    </Stack>
                  </Paper>
                )}
                <Title order={2}>{t`Редакции клинических записей`}</Title>
                <TextInput
                  label={t`Поиск по содержимому истории`}
                  {...filters.getInputProps("query")}
                />
                <NativeSelect
                  label={t`Клиническая запись`}
                  data={[{ value: "", label: t`Все записи` }, ...choices]}
                  {...filters.getInputProps("record")}
                />
                {selected.length === 0 && <Text>{t`Редакций по выбранным условиям нет.`}</Text>}
                <Accordion multiple>
                  {selected.map((record) => (
                    <Accordion.Item value={record.clientId} key={record.clientId}>
                      <Accordion.Control>
                        {record.content.title} — {t`Редакция`} {record.revision} —{" "}
                        {i18n.date(new Date(record.recordedAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack>
                          <Text>
                            {t`Автор записи`}:{" "}
                            {names.get(record.recordedBy) ??
                              (record.recordedBy || t`Автор не указан`)}
                          </Text>
                          <Badge>
                            {record.confirmed
                              ? t`Подтверждено сервером`
                              : t`Локальная редакция; ожидает подтверждения`}
                          </Badge>
                          {record.content.rows.map(([label, value], index) => (
                            <Stack key={index}>
                              <Text fw={600}>{label}</Text>
                              <Text>{value}</Text>
                            </Stack>
                          ))}
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
                {selectedCurrent.length > 0 && (
                  <>
                    <Title order={2}>{t`Текущие записи без загруженной архивной редакции`}</Title>
                    {selectedCurrent.map((record) => {
                      const content = record.content;
                      return (
                        <Paper withBorder p="md" key={record.clientId}>
                          <Stack>
                            <Title order={3}>{content.title}</Title>
                            <Text>
                              {t`Редакция`}: {record.revision}
                            </Text>
                            <Text>{t`Показана текущая запись. Архивная редакция появится после подготовки истории или следующего изменения.`}</Text>
                            {content.rows.map(([label, value], index) => (
                              <Stack key={index}>
                                <Text fw={600}>{label}</Text>
                                <Text>{value}</Text>
                              </Stack>
                            ))}
                          </Stack>
                        </Paper>
                      );
                    })}
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
