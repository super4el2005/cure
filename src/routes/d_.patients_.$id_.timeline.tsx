import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  MultiSelect,
  Select,
  Pagination,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Text,
  TextInput,
  Timeline,
  Title,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { createFileRoute, Link } from "@tanstack/react-router";

import { clinicalHistoryContent } from "@/src/lib/clinical-history-content";
import {
  defaultTimelineFilters,
  patientTimeline,
  timelineFiltersSchema,
} from "@/src/lib/patient-timeline";
import type { TimelineEventType } from "@/src/lib/patient-timeline";
import { useClinicalHistory } from "@/src/lib/use-clinical-history";

export const Route = createFileRoute("/d_/patients_/$id_/timeline")({ component: PatientTimeline });
function PatientTimeline() {
  const { id } = Route.useParams();
  const { t, i18n } = useLingui();
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
    records,
    current,
    patients,
    names,
  } = useClinicalHistory(id, false);
  const filters = useForm({
    initialValues: { ...defaultTimelineFilters, query: "", page: 1, scope: "", patientId: "" },
  });
  const effective =
    workspace && filters.values.scope === workspace.scope && filters.values.patientId === id
      ? filters.values
      : { ...filters.getInitialValues() };
  const update = (value: Partial<typeof filters.values>) =>
    filters.setValues({
      ...effective,
      page: 1,
      ...value,
      scope: workspace?.scope ?? "",
      patientId: id,
    });
  const parsed = timelineFiltersSchema.safeParse(effective);
  const patient = rows.find((row) => row.clientId === id);
  const events =
    workspace && patient && parsed.success
      ? patientTimeline(
          records,
          {
            patientId: id,
            role: opened?.role ?? "",
            expiresAt: workspace.expiresAt,
            now: Date.now(),
          },
          parsed.data,
        )
      : [];
  const kinds = {
    history: t`Анамнез`,
    allergy: t`Аллергия`,
    medication: t`Лекарственная терапия`,
    observation: t`Результат обследования`,
    visit: t`Клинический визит`,
    questionnaire: t`Опросник`,
    enrollment: t`Участие в исследовании`,
    studyVisit: t`Визит исследования`,
    qualityReview: t`Проверка качества данных`,
    studyIssue: t`Безопасность исследования`,
  };
  const eventLabels: Record<TimelineEventType, string> = {
    entry: t`Дата клинической записи`,
    medicationStart: t`Указанная дата начала терапии`,
    medicationEnd: t`Дата завершения терапии по записи`,
    medicationEndUnconfirmed: t`Дата окончания без подтверждения завершения терапии`,
    visitSchedule: t`Расписание визита`,
    visitPerformed: t`Фактическая дата исследовательского визита`,
    followUp: t`Рекомендованное повторное наблюдение`,
    enrollment: t`Решение об участии`,
    issueOnset: t`Начало события безопасности`,
    issueDetected: t`Обнаружение события безопасности`,
    issueReviewDue: t`Срок рассмотрения события безопасности`,
    issueReview: t`Рассмотрение события безопасности`,
    issueEnd: t`Дата исхода нежелательного явления`,
  };
  const phases = {
    recorded: t`По записи`,
    schedule: t`Расписание`,
    unconfirmed: t`Завершение не подтверждено`,
  };
  const participation = {
    screening: t`Скрининг`,
    ineligible: t`Не соответствует критериям`,
    enrolled: t`Включён`,
    declined: t`Отказ`,
    withdrawn: t`Выбыл`,
    completed: t`Завершено`,
  };
  const sourceStatuses = {
    active: t`Активно`,
    inactive: t`Неактивно`,
    completed: t`Завершено`,
    stopped: t`Прекращено`,
    planned: t`Запланирован`,
    inProgress: t`Выполняется`,
    cancelled: t`Отменено`,
    noShow: t`Неявка`,
    draft: t`Черновик`,
    final: t`Окончательный ответ`,
    open: t`Открыто`,
    underReview: t`На рассмотрении`,
    resolved: t`Рассмотрено`,
    closed: t`Закрыто`,
  };
  const visitTypes = {
    consultation: t`Консультация`,
    procedure: t`Процедура`,
    hospitalization: t`Госпитализация`,
    followUp: t`Повторный приём`,
  };
  const contentBySource = new Map<string, ReturnType<typeof clinicalHistoryContent>>();
  const displayed = events
    .map((event) => {
      let content = contentBySource.get(event.source.clientId);
      if (!content) {
        content = clinicalHistoryContent(event.source.payload!, i18n, names);
        contentBySource.set(event.source.clientId, content);
      }
      return { ...event, content };
    })
    .filter((event) =>
      `${eventLabels[event.type]} ${event.detail} ${event.content.title} ${event.content.rows.flat().join(" ")}`
        .toLocaleLowerCase(i18n.locale)
        .includes(effective.query.trim().toLocaleLowerCase(i18n.locale)),
    );
  const pages = Math.max(1, Math.ceil(displayed.length / 25));
  const page = Math.min(effective.page, pages);
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor
          renderRoot={(props) => <Link {...props} to="/d/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Хронология пациента`}</Title>
        <Text>{t`Клинические и исследовательские события пациента.`}</Text>
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
        {(unlock.isError || lock.isError || resume.isError) && (
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
                disabled={!online}
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                loading={lock.isPending}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {opened?.role !== "doctor" ? (
              <Alert>{t`Полная клиническая хронология доступна только врачу своей организации. Исследователь не получает дополнительные категории данных через эту страницу.`}</Alert>
            ) : !patients.isReady || !current.isReady ? (
              <Text>{t`Загрузка локальных данных…`}</Text>
            ) : !patient ? (
              <Alert>{t`Пациент недоступен, удалён или ещё не подготовлен на устройстве.`}</Alert>
            ) : (
              <>
                <Title order={2}>{patient.fullName}</Title>
                <Anchor
                  renderRoot={(props) => (
                    <Link {...props} to="/d/patients/$id/history" params={{ id }} />
                  )}
                >{t`История редакций карты и записей`}</Anchor>
                <Alert>{t`События отсортированы по календарной дате источника. Внутри дня порядок условный; часовой пояс расписания указан отдельно. Дата записи и расписание не доказывают фактическое проведение события.`}</Alert>
                {!status.data?.online && (
                  <Alert>{t`Показаны локальные данные. Новые изменения и отзывы доступа других участников могут быть ещё не получены. Неотправленные изменения учитываются в ленте.`}</Alert>
                )}
                {(!workspace.collection.has(workspace.patientSnapshotId) ||
                  !workspace.clinicalRecords.has(workspace.clinicalSnapshotId)) && (
                  <Alert color="yellow">{t`Набор ещё не подготовлен полностью. Показаны доступные локальные события; отсутствие события не означает, что его нет на сервере.`}</Alert>
                )}
                <Text>
                  {t`В очереди:`} {status.data?.pending ?? 0}
                </Text>
                <Paper withBorder p="sm">
                  <Stack gap="sm">
                    <DateInput
                      label={t`С даты включительно`}
                      valueFormat="YYYY-MM-DD"
                      clearable
                      value={effective.from || null}
                      onChange={(value) => update({ from: value ?? "" })}
                    />
                    <DateInput
                      label={t`По дату включительно`}
                      valueFormat="YYYY-MM-DD"
                      clearable
                      value={effective.to || null}
                      onChange={(value) => update({ to: value ?? "" })}
                    />
                    <MultiSelect
                      label={t`Категории хронологии`}
                      data={Object.entries(kinds).map(([value, label]) => ({ value, label }))}
                      value={effective.kinds}
                      onChange={(value) => update({ kinds: value as typeof effective.kinds })}
                    />
                    <Select
                      allowDeselect={false}
                      label={t`Вид даты`}
                      data={[
                        { value: "all", label: t`Все даты` },
                        ...Object.entries(phases).map(([value, label]) => ({ value, label })),
                      ]}
                      value={effective.phase}
                      onChange={(value) =>
                        update({ phase: (value ?? "") as typeof effective.phase })
                      }
                    />
                    <TextInput
                      label={t`Поиск в текущем содержимом источников`}
                      value={effective.query}
                      onChange={(event) => update({ query: event.currentTarget.value })}
                    />
                    {!parsed.success && (
                      <Alert color="red">{t`Проверьте период: начальная дата не должна быть позже конечной.`}</Alert>
                    )}
                    <Button
                      variant="default"
                      onClick={() => update({ ...defaultTimelineFilters, query: "" })}
                    >{t`Сбросить фильтры`}</Button>
                  </Stack>
                </Paper>
                <Text>
                  {t`Событий по фильтрам:`} {displayed.length}
                </Text>
                {parsed.success && displayed.length === 0 && (
                  <Text>{t`В доступных локальных записях нет событий по этим фильтрам.`}</Text>
                )}
                <Timeline>
                  {displayed.slice((page - 1) * 25, page * 25).map((event) => (
                    <Timeline.Item
                      key={event.key}
                      title={`${i18n.date(new Date(`${event.date}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })} — ${eventLabels[event.type]}`}
                    >
                      <Stack gap="sm">
                        <Group>
                          <Badge>{kinds[event.source.payload!.kind]}</Badge>
                          <Badge>{phases[event.phase]}</Badge>
                          {event.enrollmentStatus && (
                            <Badge>{participation[event.enrollmentStatus]}</Badge>
                          )}
                        </Group>
                        {event.source.payload && "status" in event.source.payload && (
                          <Text>
                            {t`Текущий статус источника:`}{" "}
                            {sourceStatuses[event.source.payload.status]}
                          </Text>
                        )}
                        {event.source.payload &&
                          (event.source.payload.kind === "visit" ||
                            event.source.payload.kind === "studyVisit") && (
                            <Text>{visitTypes[event.source.payload.visitType]}</Text>
                          )}
                        <Text>{event.detail}</Text>
                        {event.scheduledFor && (
                          <Text>
                            {t`Время и часовой пояс расписания:`} {event.scheduledFor}
                          </Text>
                        )}
                        {event.author && (
                          <Text>
                            {t`Автор события:`} {names.get(event.author) ?? event.author}
                          </Text>
                        )}
                        {event.recordedAt !== null && (
                          <Text>
                            {t`Время фиксации внутри события:`}{" "}
                            {i18n.date(new Date(event.recordedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                        )}
                        <Text>
                          {t`Редакция источника:`} {event.source.revision} —{" "}
                          {t`Последнее сохранение источника:`}{" "}
                          {i18n.date(new Date(event.source.updatedAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}{" "}
                          —{" "}
                          {event.source.updatedBy
                            ? (names.get(event.source.updatedBy) ?? event.source.updatedBy)
                            : t`Автор не указан`}
                        </Text>
                        <Accordion>
                          <Accordion.Item value={event.key}>
                            <Accordion.Control>{t`Текущее содержимое источника`}</Accordion.Control>
                            <Accordion.Panel>
                              <Stack gap="sm">
                                <Text>{t`Это текущая редакция записи, а не снимок её состояния на дату события. Исторические значения открываются в истории редакций.`}</Text>
                                <Table>
                                  <Table.Tbody>
                                    {event.content.rows.map(([label, value], index) => (
                                      <Table.Tr key={index}>
                                        <Table.Th>{label}</Table.Th>
                                        <Table.Td>{value}</Table.Td>
                                      </Table.Tr>
                                    ))}
                                  </Table.Tbody>
                                </Table>
                              </Stack>
                            </Accordion.Panel>
                          </Accordion.Item>
                        </Accordion>
                      </Stack>
                    </Timeline.Item>
                  ))}
                </Timeline>
                <Pagination
                  total={pages}
                  value={page}
                  onChange={(value) => update({ page: value })}
                />
                <Text>{t`Показано до 25 событий на странице. Одна запись может содержать несколько дат. Удалённые записи не включаются; лента не заменяет историю редакций и не подтверждает полноту медицинской истории вне системы.`}</Text>
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
