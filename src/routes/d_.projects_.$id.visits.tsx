import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  Select,
  NumberInput,
  Paper,
  PasswordInput,
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
import { useStudyVisits } from "@/src/lib/use-study-visits";
import { visitTime } from "@/src/lib/visit-time";

export const Route = createFileRoute("/d_/projects_/$id/visits")({ component: StudyVisits });
function StudyVisits() {
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
    downloaded,
    project,
    canConduct,
    source,
    enrollments,
    available,
    visits,
    patients,
    editing,
    editor,
    form,
    selectEnrollment,
    save,
    remove,
    restore,
    failures,
    blocker,
    start,
    edit,
  } = useStudyVisits(id);
  const labels = {
    planned: t`Запланирован`,
    inProgress: t`Визит проводится`,
    completed: t`Визит выполнен`,
    cancelled: t`Визит отменён`,
    noShow: t`Пациент не явился`,
  };
  const types = {
    consultation: t`Консультация`,
    procedure: t`Процедура`,
    hospitalization: t`Госпитализация`,
    followUp: t`Повторный приём`,
  };
  const filter = useForm({ initialValues: { status: "all" } });
  const visible = visits.filter(
    (row) =>
      row.payload?.kind === "studyVisit" &&
      (filter.values.status === "all" || filter.values.status === row.payload.status),
  );
  const locked = Boolean(
    form.values.original &&
    ["completed", "cancelled", "noShow"].includes(form.values.original.status),
  );
  const enrolled = enrollments.find((row) => row.clientId === form.values.enrollmentClientId);
  const replace = (action: () => void) => {
    if (editing && form.isDirty())
      modals.openConfirmModal({
        title: t`Заменить несохранённую запись?`,
        children: (
          <Text>{t`Изменения в редакторе будут потеряны. Сохранённые записи останутся доступными.`}</Text>
        ),
        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
        onConfirm: action,
      });
    else action();
  };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        {blocker.status === "blocked" && (
          <Modal
            opened
            title={t`Покинуть страницу с несохранёнными изменениями?`}
            onClose={blocker.reset}
          >
            <Stack gap="sm">
              <Text>{t`Изменения в редакторе не сохранены на устройстве. Вернитесь и сохраните их или подтвердите выход.`}</Text>
              <Group>
                <Button onClick={blocker.reset}>{t`Остаться`}</Button>
                <Button color="red" onClick={blocker.proceed}>{t`Выйти без сохранения`}</Button>
              </Group>
            </Stack>
          </Modal>
        )}
        <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/d/projects/$id/enrollment" params={{ id }} />
          )}
        >{t`Журнал набора клиники`}</Anchor>
        <Title>{t`Визиты исследования`}</Title>
        <Text>{project?.title ?? id}</Text>
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

        {(unlock.isError ||
          lock.isError ||
          resume.isError ||
          save.isError ||
          remove.isError ||
          restore.isError ||
          failures.isError) && (
          <Alert color="red">{t`Не удалось сохранить визит. Проверьте участие, согласие, протокол, расписание и текущую версию записи. Ввод остаётся в редакторе.`}</Alert>
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
            {opened.role !== "doctor" ? (
              <Alert>{t`Клинические визиты исследования доступны только врачу своей клиники. Проектная роль не открывает медицинские результаты.`}</Alert>
            ) : (
              <>
                <Alert>{t`Это расписание выбранной клиники, включая ожидающие синхронизации изменения. Приглашения и напоминания пациентам автоматически не отправляются.`}</Alert>
                {!canConduct && (
                  <Alert>
                    <Text>{t`Для назначения и проведения нужны открытое исследовательское пространство той же организации, действующий протокол и право внесения данных. Существующий визит можно отменить, а сохранённый результат — исправить с обоснованием.`}</Text>
                    <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
                  </Alert>
                )}
                {(!downloaded.isReady || !source.isReady) && (
                  <Text>{t`Загрузка локальных данных…`}</Text>
                )}
                <Button
                  disabled={
                    !workspace.canWrite() ||
                    !source.isReady ||
                    !canConduct ||
                    !available.length ||
                    save.isPending ||
                    remove.isPending
                  }
                  onClick={() => replace(start)}
                >{t`Назначить визит исследования`}</Button>
                {save.isSuccess && (
                  <Alert color="green">{t`Визит сохранён в очереди устройства. При синхронизации сервер повторно проверит участие, согласие и права.`}</Alert>
                )}
                {editing &&
                  form.values.scope === workspace.scope &&
                  form.values.projectId === id && (
                    <Paper withBorder p="sm">
                      <form onSubmit={form.onSubmit((input) => save.mutate(input))}>
                        <Stack gap="sm">
                          {form.values.failureId && (
                            <Alert color="yellow">{t`Открыт отклонённый черновик. Сравните его с текущими данными перед сохранением.`}</Alert>
                          )}
                          {!form.values.clientId ? (
                            <Select
                              allowDeselect={false}
                              label={t`Участник исследования`}
                              required
                              value={form.values.enrollmentClientId}
                              onChange={selectEnrollment}
                              data={available.map((row) => ({
                                value: row.clientId,
                                label:
                                  patients.find(
                                    (patient) => patient.clientId === row.patientClientId,
                                  )?.fullName ?? row.patientClientId,
                              }))}
                            />
                          ) : (
                            <Text>
                              {patients.find((row) => row.clientId === form.values.patientClientId)
                                ?.fullName ?? form.values.patientClientId}
                            </Text>
                          )}
                          {enrolled?.payload?.kind === "enrollment" &&
                            (enrolled.payload.writeId !== form.values.enrollmentWriteId ||
                              enrolled.payload.events.at(-1)?.status !== "enrolled") && (
                              <Alert color="yellow">{t`Участие пациента изменилось или завершено. Новое проведение требует повторной проверки; отмена остаётся доступной.`}</Alert>
                            )}
                          <DateTimePicker
                            label={t`Местные дата и время визита`}
                            required
                            disabled={locked}
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD HH:mm"
                            {...form.getInputProps("scheduledLocal")}
                          />
                          <TextInput
                            label={t`Часовой пояс IANA`}
                            required
                            disabled={locked}
                            {...form.getInputProps("timeZone")}
                          />
                          <Select
                            allowDeselect={false}
                            label={t`Повторяющийся час при переводе часов`}
                            disabled={locked}
                            data={[
                              { value: "reject", label: t`Требовать уточнение` },
                              { value: "earlier", label: t`Первое вхождение` },
                              { value: "later", label: t`Второе вхождение` },
                            ]}
                            {...form.getInputProps("disambiguation")}
                          />
                          <NumberInput
                            label={t`Продолжительность, минуты`}
                            required
                            min={1}
                            max={1440}
                            clampBehavior="none"
                            disabled={locked}
                            {...form.getInputProps("durationMinutes")}
                          />
                          <DateInput
                            label={t`Допустимое окно (UTC): с`}
                            required
                            disabled={locked}
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("windowFrom")}
                          />
                          <DateInput
                            label={t`Допустимое окно (UTC): по`}
                            required
                            disabled={locked}
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("windowTo")}
                          />
                          <Textarea
                            label={t`Обоснование отклонения от окна визита`}
                            maxLength={2000}
                            {...form.getInputProps("deviationReason")}
                          />
                          <Select
                            allowDeselect={false}
                            label={t`Тип визита`}
                            data={Object.entries(types).map(([value, label]) => ({ value, label }))}
                            {...form.getInputProps("visitType")}
                          />
                          <Select
                            label={t`Статус визита`}
                            allowDeselect={false}
                            data={(form.values.original
                              ? visitTransitions[form.values.original.status]
                              : ["planned" as const]
                            ).map((value) => ({ value, label: labels[value] }))}
                            {...form.getInputProps("status")}
                          />
                          <TextInput
                            label={t`Цель визита`}
                            required
                            maxLength={1000}
                            {...form.getInputProps("reason")}
                          />
                          <TextInput
                            label={t`Место проведения`}
                            maxLength={200}
                            {...form.getInputProps("location")}
                          />
                          <DateInput
                            label={t`Фактическая дата проведения (UTC)`}
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("performedOn")}
                          />
                          <Textarea
                            label={t`Результат визита`}
                            required={form.values.status === "completed"}
                            maxLength={10000}
                            {...form.getInputProps("outcome")}
                          />
                          <Textarea
                            label={t`Причина отмены`}
                            required={form.values.status === "cancelled"}
                            maxLength={1000}
                            {...form.getInputProps("cancellationReason")}
                          />
                          <Textarea
                            label={t`Примечания`}
                            maxLength={2000}
                            {...form.getInputProps("notes")}
                          />
                          {locked && (
                            <Textarea
                              label={t`Причина исправления`}
                              required
                              maxLength={2000}
                              {...form.getInputProps("amendmentReason")}
                            />
                          )}
                          <Group>
                            <Button
                              type="submit"
                              loading={save.isPending}
                              disabled={!workspace.canWrite() || remove.isPending}
                            >{t`Сохранить на устройстве`}</Button>
                            <Button
                              variant="default"
                              disabled={save.isPending}
                              onClick={() =>
                                replace(() => {
                                  form.reset();
                                  editor.close();
                                })
                              }
                            >{t`Отмена`}</Button>
                          </Group>
                        </Stack>
                      </form>
                    </Paper>
                  )}
                <Select
                  allowDeselect={false}
                  label={t`Фильтр по статусу`}
                  data={[
                    { value: "all", label: t`Все статусы` },
                    ...Object.entries(labels).map(([value, label]) => ({ value, label })),
                  ]}
                  {...filter.getInputProps("status")}
                />
                {source.isReady && visible.length === 0 && (
                  <Text>{t`Визитов по выбранным условиям нет.`}</Text>
                )}
                {visible.map((record) => {
                  const value = record.payload;
                  if (value?.kind !== "studyVisit") return null;
                  const scheduled = visitTime(value.scheduledFor);
                  return (
                    <Paper key={record.clientId} withBorder p="sm">
                      <Stack gap="sm">
                        <Anchor
                          renderRoot={(props) => (
                            <Link
                              {...props}
                              to="/d/patients/$id/enrollment"
                              params={{ id: record.patientClientId }}
                            />
                          )}
                        >
                          {patients.find((row) => row.clientId === record.patientClientId)
                            ?.fullName ?? record.patientClientId}
                        </Anchor>
                        <Group>
                          <Badge>{labels[value.status]}</Badge>
                          <Badge>{types[value.visitType]}</Badge>
                        </Group>
                        <Text fw={600}>{value.reason}</Text>
                        <Text>
                          {i18n.date(scheduled.epoch, {
                            timeZone: scheduled.timeZone,
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}{" "}
                          · {scheduled.timeZone} · {value.durationMinutes} {t`мин`}
                        </Text>
                        <Text>
                          {t`Допустимое окно (UTC):`} {value.windowFrom} — {value.windowTo}
                        </Text>
                        <Text>{value.location}</Text>
                        {value.performedOn && (
                          <Text>
                            {t`Фактическая дата проведения (UTC)`}: {value.performedOn}
                          </Text>
                        )}
                        {value.outcome && <Text>{value.outcome}</Text>}
                        {value.deviationReason && (
                          <Alert color="yellow">
                            {t`Отклонение:`} {value.deviationReason}
                          </Alert>
                        )}
                        {value.cancellationReason && <Text>{value.cancellationReason}</Text>}
                        <Text>{value.notes}</Text>
                        {value.amendmentReason && (
                          <Text>
                            {t`Причина исправления:`} {value.amendmentReason}
                          </Text>
                        )}
                        <Text size="sm">
                          {t`Версия протокола:`} {value.protocolVersion} · {value.protocolClientId}
                        </Text>
                        <Group>
                          <Button
                            variant="default"
                            disabled={!workspace.canWrite() || save.isPending || remove.isPending}
                            onClick={() => replace(() => edit(record))}
                          >{t`Изменить визит`}</Button>
                          <Button
                            color="red"
                            variant="light"
                            disabled={!workspace.canWrite() || save.isPending || remove.isPending}
                            onClick={() =>
                              modals.openConfirmModal({
                                title: t`Удалить визит?`,
                                children: (
                                  <Text>{t`Содержимое визита будет очищено после синхронизации. Для отмены назначенного визита используйте статус отмены.`}</Text>
                                ),
                                labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                onConfirm: () => remove.mutate(record),
                              })
                            }
                          >{t`Удалить`}</Button>
                        </Group>
                      </Stack>
                    </Paper>
                  );
                })}
                {failures.data?.map((failure) => (
                  <Alert key={failure.id} color="yellow">
                    <Stack gap="sm">
                      <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      {failure.action !== "delete" ? (
                        <Button
                          variant="default"
                          disabled={save.isPending}
                          onClick={() => replace(() => restore.mutate(failure))}
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
      </Stack>
    </Container>
  );
}
