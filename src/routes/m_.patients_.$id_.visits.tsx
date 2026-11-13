import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Fieldset,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateInput, DateTimePicker } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";
import "dayjs/locale/ru";

import { visitTransitions } from "@/src/lib/clinical-record-model";
import { useClinicalRecords } from "@/src/lib/use-clinical-records";
import { visitTime } from "@/src/lib/visit-time";

export const Route = createFileRoute("/m_/patients_/$id_/visits")({ component: Visits });
function Visits() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    userId,
    online,
    workspace,
    opened,
    rows,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    status,
    downloaded,
    clinical,
    localClinical,
    clinicalForm,
    clinicalEditing,
    clinicalEditor,
    createClinical,
    editClinical,
    saveClinical,
    deleteClinical,
    restoreClinical,
    clinicalFailures,
  } = useClinicalRecords(id, "visits");
  const filter = useForm({ initialValues: { status: "all" } });
  const patient = rows.find((row) => row.clientId === id);
  const statusLabels = {
    planned: t`Запланирован`,
    inProgress: t`Идёт приём`,
    completed: t`Приём завершён`,
    cancelled: t`Визит отменён`,
    noShow: t`Пациент не явился`,
  };
  const typeLabels = {
    consultation: t`Консультация`,
    procedure: t`Процедура`,
    hospitalization: t`Госпитализация`,
    followUp: t`Повторный приём`,
  };
  const visits = clinical
    .filter(
      (row) =>
        row.payload?.kind === "visit" &&
        (filter.values.status === "all" || row.payload.status === filter.values.status),
    )
    .sort((a, b) =>
      a.payload?.kind === "visit" && b.payload?.kind === "visit"
        ? visitTime(b.payload.scheduledFor).epoch - visitTime(a.payload.scheduledFor).epoch
        : 0,
    );
  const scheduleLocked =
    Boolean(clinicalForm.values.clientId) &&
    ["completed", "cancelled", "noShow"].includes(clinicalForm.values.originalVisitStatus);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor
          renderRoot={(props) => <Link {...props} to="/m/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Визиты пациента`}</Title>
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
                {!online && (
                  <Text>{t`Без сети доступны только ранее подготовленные пространства с действующим сроком доступа.`}</Text>
                )}
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError ||
          lock.isError ||
          resume.isError ||
          saveClinical.isError ||
          deleteClinical.isError ||
          restoreClinical.isError) && (
          <Alert color="red">{t`Не удалось сохранить изменение. Проверьте права и текущую версию записи. Ваш ввод остаётся в форме.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
                loading={lock.isPending}
              >{t`Заблокировать пространство`}</Button>
              <Text>{t`В очереди: ${status.data?.pending ?? 0}`}</Text>
            </Group>
            {!status.data?.online && (
              <Alert>
                {t`Синхронизация приостановлена. Нужны сеть и подтверждённая сессия того же пользователя.`}
                <Button
                  variant="default"
                  disabled={!online}
                  loading={resume.isPending}
                  onClick={() => resume.mutate()}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            {opened.role !== "doctor" ? (
              <Alert>{t`Согласие на пол и диагнозы не открывает расписание и содержание визитов исследователю.`}</Alert>
            ) : (
              <>
                {!downloaded.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
                {downloaded.isReady && !patient && (
                  <Alert>{t`Пациент не найден или недоступен в выбранной организации.`}</Alert>
                )}
                {patient && (
                  <>
                    <Title order={2}>{patient.fullName}</Title>
                    <Button
                      disabled={!workspace.canWrite()}
                      onClick={createClinical}
                    >{t`Добавить визит`}</Button>
                    {clinicalEditing && clinicalForm.values.patientClientId === id && (
                      <Paper withBorder p="md">
                        <form
                          onSubmit={clinicalForm.onSubmit((values) => saveClinical.mutate(values))}
                        >
                          <Fieldset disabled={saveClinical.isPending}>
                            <Stack>
                              <DateTimePicker
                                label={t`Дата и время визита`}
                                locale={i18n.locale}
                                required
                                disabled={scheduleLocked}
                                {...clinicalForm.getInputProps("scheduledLocal")}
                              />
                              <Select
                                label={t`Часовой пояс визита`}
                                searchable
                                allowDeselect={false}
                                disabled={scheduleLocked}
                                data={[
                                  ...new Set([
                                    "UTC",
                                    clinicalForm.values.timeZone,
                                    ...Intl.supportedValuesOf("timeZone"),
                                  ]),
                                ]}
                                {...clinicalForm.getInputProps("timeZone")}
                              />
                              <NativeSelect
                                label={t`При повторении часа при переводе часов`}
                                disabled={scheduleLocked}
                                data={[
                                  { value: "reject", label: t`Требовать однозначное время` },
                                  { value: "earlier", label: t`Первое вхождение часа` },
                                  { value: "later", label: t`Второе вхождение часа` },
                                ]}
                                {...clinicalForm.getInputProps("disambiguation")}
                              />
                              <NumberInput
                                label={t`Продолжительность в минутах`}
                                required
                                min={1}
                                max={1440}
                                allowDecimal={false}
                                disabled={scheduleLocked}
                                {...clinicalForm.getInputProps("durationMinutes")}
                              />
                              {scheduleLocked && (
                                <Text>{t`Время завершённого или отменённого визита не переносится. Для нового приёма создайте отдельный визит.`}</Text>
                              )}
                              <NativeSelect
                                label={t`Тип визита`}
                                data={Object.entries(typeLabels).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...clinicalForm.getInputProps("visitType")}
                              />
                              <NativeSelect
                                label={t`Статус визита`}
                                data={Object.entries(statusLabels)
                                  .filter(
                                    ([value]) =>
                                      !clinicalForm.values.clientId ||
                                      visitTransitions[
                                        clinicalForm.values.originalVisitStatus
                                      ].includes(value as keyof typeof statusLabels),
                                  )
                                  .map(([value, label]) => ({ value, label }))}
                                {...clinicalForm.getInputProps("visitStatus")}
                              />
                              <Textarea
                                label={t`Причина обращения`}
                                required
                                maxLength={1000}
                                {...clinicalForm.getInputProps("reason")}
                              />
                              <TextInput
                                label={t`Место проведения`}
                                maxLength={200}
                                {...clinicalForm.getInputProps("location")}
                              />
                              <Textarea
                                label={t`Результат приёма и дальнейшие действия`}
                                required={clinicalForm.values.visitStatus === "completed"}
                                maxLength={10000}
                                {...clinicalForm.getInputProps("outcome")}
                              />
                              {clinicalForm.values.visitStatus === "cancelled" && (
                                <Textarea
                                  label={t`Причина отмены`}
                                  required
                                  maxLength={1000}
                                  {...clinicalForm.getInputProps("cancellationReason")}
                                />
                              )}
                              <DateInput
                                label={t`Дата последующего наблюдения`}
                                locale={i18n.locale}
                                clearable
                                {...clinicalForm.getInputProps("followUpOn")}
                              />
                              <Textarea
                                label={t`Примечание к записи`}
                                maxLength={2000}
                                {...clinicalForm.getInputProps("notes")}
                              />
                              {clinicalForm.values.failureId && !clinicalForm.values.clientId && (
                                <Alert>{t`Черновик будет сохранён как новая клиническая запись. Удалённая версия не восстанавливается автоматически.`}</Alert>
                              )}
                              <Group>
                                <Button
                                  type="submit"
                                  disabled={!workspace.canWrite()}
                                  loading={saveClinical.isPending}
                                >{t`Сохранить на устройстве`}</Button>
                                <Button
                                  variant="default"
                                  onClick={() => {
                                    clinicalForm.reset();
                                    clinicalEditor.close();
                                  }}
                                >{t`Отмена`}</Button>
                              </Group>
                            </Stack>
                          </Fieldset>
                        </form>
                      </Paper>
                    )}
                    {(saveClinical.isSuccess || deleteClinical.isSuccess) && (
                      <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                    )}
                    <NativeSelect
                      label={t`Фильтр по статусу визита`}
                      data={[
                        { value: "all", label: t`Все статусы` },
                        ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
                      ]}
                      {...filter.getInputProps("status")}
                    />
                    {!localClinical.isReady && (
                      <Text>{t`Визиты ещё не загружены. Для первой загрузки нужен интернет.`}</Text>
                    )}
                    {localClinical.isReady && visits.length === 0 && (
                      <Text>{t`Нет визитов с выбранным статусом.`}</Text>
                    )}
                    {visits.map(
                      (record) =>
                        record.payload?.kind === "visit" && (
                          <Paper withBorder p="md" key={record.clientId}>
                            <Stack>
                              <Group>
                                <Badge>{statusLabels[record.payload.status]}</Badge>
                                <Badge>{typeLabels[record.payload.visitType]}</Badge>
                                <Text>
                                  {t`Версия:`} {record.revision}
                                </Text>
                              </Group>
                              <Title order={3}>
                                {i18n.date(new Date(visitTime(record.payload.scheduledFor).epoch), {
                                  timeZone: visitTime(record.payload.scheduledFor).timeZone,
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  timeZoneName: "shortOffset",
                                })}
                              </Title>
                              <Text>{visitTime(record.payload.scheduledFor).timeZone}</Text>
                              <Text>
                                {t`Продолжительность в минутах:`} {record.payload.durationMinutes}
                              </Text>
                              {record.payload.status === "planned" &&
                                visitTime(record.payload.scheduledFor).epoch +
                                  record.payload.durationMinutes * 60000 <
                                  Date.now() && (
                                  <Badge color="orange">{t`Плановое время прошло; уточните результат визита`}</Badge>
                                )}
                              <Text>{record.payload.reason}</Text>
                              <Text>{record.payload.location}</Text>
                              <Text>{record.payload.outcome}</Text>
                              {record.payload.status === "cancelled" && (
                                <Text>
                                  {t`Причина отмены:`} {record.payload.cancellationReason}
                                </Text>
                              )}
                              {record.payload.followUpOn && (
                                <Text>
                                  {t`Последующее наблюдение:`}{" "}
                                  {i18n.date(new Date(`${record.payload.followUpOn}T12:00:00`), {
                                    dateStyle: "medium",
                                  })}
                                </Text>
                              )}
                              <Text>{record.payload.notes}</Text>
                              <Group>
                                <Button
                                  variant="default"
                                  disabled={!workspace.canWrite()}
                                  onClick={() => editClinical(record)}
                                >{t`Изменить визит`}</Button>
                                <Button
                                  color="red"
                                  variant="light"
                                  disabled={!workspace.canWrite() || deleteClinical.isPending}
                                  onClick={() =>
                                    modals.openConfirmModal({
                                      title: t`Удалить визит?`,
                                      children: (
                                        <Text>{t`Содержимое будет очищено после синхронизации. В истории останется запись о действии.`}</Text>
                                      ),
                                      labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                      onConfirm: () => deleteClinical.mutate(record),
                                    })
                                  }
                                >{t`Удалить`}</Button>
                              </Group>
                            </Stack>
                          </Paper>
                        ),
                    )}
                    {clinicalFailures.data?.map((failure) => (
                      <Alert color="yellow" key={failure.id}>
                        <Stack>
                          <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                          <Text>{failure.code}</Text>
                          {failure.action !== "delete" ? (
                            <Button
                              variant="default"
                              onClick={() => restoreClinical.mutate(failure)}
                            >{t`Открыть сохранённый черновик`}</Button>
                          ) : (
                            <Text>{t`Удаление отклонено. Сравните текущую запись перед повторным удалением.`}</Text>
                          )}
                        </Stack>
                      </Alert>
                    ))}
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
