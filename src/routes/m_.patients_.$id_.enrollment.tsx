import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Modal,
  NativeSelect,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";
import "dayjs/locale/ru";

import { enrollmentTransitions } from "@/src/lib/study-enrollment-model";
import { useStudyEnrollments } from "@/src/lib/use-study-enrollments";

export const Route = createFileRoute("/m_/patients_/$id_/enrollment")({ component: Enrollment });
function Enrollment() {
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
    projects,
    projectMap,
    protocols,
    protocolSource,
    available,
    source,
    records,
    editing,
    editor,
    form,
    save,
    remove,
    restore,
    failures,
    blocker,
    start,
    advance,
  } = useStudyEnrollments(id);
  const patient = rows.find((row) => row.clientId === id);
  const labels = {
    screening: t`Скрининг`,
    ineligible: t`Критерии не выполнены`,
    enrolled: t`Включён`,
    declined: t`Отказ`,
    withdrawn: t`Выбытие`,
    completed: t`Участие завершено`,
  };
  const previousStatus = form.values.previous?.events.at(-1)?.status;
  const allowed = previousStatus ? enrollmentTransitions[previousStatus] : ["screening" as const];
  const protocol = protocols.find(
    (row) =>
      row.clientId === (form.values.previous?.protocolClientId ?? form.values.protocolClientId),
  );
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
    <Container component="main" py="md">
      <Stack>
        {blocker.status === "blocked" && (
          <Modal
            opened
            onClose={blocker.reset}
            title={t`Покинуть страницу с несохранёнными изменениями?`}
          >
            <Stack>
              <Text>{t`Изменения в редакторе не сохранены на устройстве. Вернитесь и сохраните их или подтвердите выход.`}</Text>
              <Group>
                <Button onClick={blocker.reset}>{t`Остаться`}</Button>
                <Button color="red" onClick={blocker.proceed}>{t`Выйти без сохранения`}</Button>
              </Group>
            </Stack>
          </Modal>
        )}
        <Anchor
          renderRoot={(props) => <Link {...props} to="/m/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Участие пациента в исследованиях`}</Title>
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
          <Alert color="red">{t`Не удалось сохранить участие. Проверьте статус исследования, протокол, согласие и текущую версию записи. Введённые данные остаются в редакторе.`}</Alert>
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
                  disabled={!online}
                  loading={resume.isPending}
                  onClick={() => resume.mutate()}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            {opened.role !== "doctor" ? (
              <Alert>{t`Записи участия доступны только врачам клиники. Согласие на пол и диагнозы не открывает эти записи исследователю.`}</Alert>
            ) : (
              <>
                {(!downloaded.isReady || !source.isReady) && (
                  <Text>{t`Загрузка локальных данных…`}</Text>
                )}
                {downloaded.isReady && !patient && (
                  <Alert>{t`Пациент не найден или недоступен в выбранной организации.`}</Alert>
                )}
                {patient && (
                  <>
                    <Title order={2}>{patient.fullName}</Title>
                    <Alert>{t`Согласие на участие фиксируется по документу отдельно от разрешения передавать медицинские данные. Электронная подпись и доступ исследователя этим действием не предоставляются.`}</Alert>
                    {!projects && (
                      <Alert>
                        <Text>{t`Для скрининга и включения откройте исследовательское пространство той же организации. Отказ и выбытие можно зафиксировать без него.`}</Text>
                        <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
                      </Alert>
                    )}
                    {projects && protocolSource.isReady && available.length === 0 && (
                      <Alert>{t`Нет доступного набора с подтверждённым протоколом и действующим этическим разрешением. Новые версии протоколов сначала нужно синхронизировать.`}</Alert>
                    )}
                    <Button
                      disabled={
                        !workspace.canWrite() ||
                        !source.isReady ||
                        available.length === 0 ||
                        save.isPending ||
                        remove.isPending
                      }
                      onClick={() => replace(start)}
                    >{t`Начать скрининг`}</Button>
                    {save.isSuccess && (
                      <Alert color="green">{t`Изменение сохранено в очереди на устройстве. Сервер подтвердит участие после проверки при синхронизации.`}</Alert>
                    )}
                    {editing &&
                      form.values.scope === workspace.scope &&
                      form.values.patientClientId === id && (
                        <Paper withBorder p="md">
                          <form onSubmit={form.onSubmit((input) => save.mutate(input))}>
                            <Stack>
                              {form.values.failureId && (
                                <Alert color="yellow">{t`Открыт отклонённый черновик. Сравните решение с текущей историей перед сохранением. Повторное применение требует явного подтверждения.`}</Alert>
                              )}
                              {!form.values.previous && (
                                <Select
                                  label={t`Исследование и протокол`}
                                  data={available.map((row) => ({
                                    value: row.clientId,
                                    label: `${projectMap.get(row.projectClientId)?.title ?? row.projectClientId} · ${row.version}`,
                                  }))}
                                  {...form.getInputProps("protocolClientId")}
                                />
                              )}
                              {protocol && (
                                <>
                                  <Text>
                                    {t`Критерии включения:`} {protocol.inclusion || "—"}
                                  </Text>
                                  <Text>
                                    {t`Критерии исключения:`} {protocol.exclusion || "—"}
                                  </Text>
                                </>
                              )}
                              <Select
                                label={t`Решение`}
                                allowDeselect={false}
                                data={allowed.map((value) => ({ value, label: labels[value] }))}
                                {...form.getInputProps("status")}
                              />
                              <DateInput
                                label={t`Дата события (UTC)`}
                                locale={i18n.locale}
                                valueFormat="YYYY-MM-DD"
                                required
                                {...form.getInputProps("occurredOn")}
                              />
                              <Textarea
                                label={t`Причина и обоснование решения`}
                                required
                                maxLength={2000}
                                {...form.getInputProps("reason")}
                              />
                              {form.values.status === "enrolled" && (
                                <>
                                  <Textarea
                                    label={t`Оценка критериев и подтверждающие сведения`}
                                    required
                                    maxLength={5000}
                                    {...form.getInputProps("eligibilityEvidence")}
                                  />
                                  <Checkbox
                                    label={t`Критерии включения выполнены`}
                                    {...form.getInputProps("inclusionConfirmed", {
                                      type: "checkbox",
                                    })}
                                  />
                                  <Checkbox
                                    label={t`Критерии исключения отсутствуют`}
                                    {...form.getInputProps("exclusionAbsent", { type: "checkbox" })}
                                  />
                                  <TextInput
                                    label={t`Ссылка или номер документа согласия на участие`}
                                    required
                                    maxLength={1000}
                                    {...form.getInputProps("documentReference")}
                                  />
                                  <TextInput
                                    label={t`Версия документа согласия`}
                                    required
                                    maxLength={100}
                                    {...form.getInputProps("consentVersion")}
                                  />
                                  <DateInput
                                    label={t`Дата подписания согласия`}
                                    locale={i18n.locale}
                                    valueFormat="YYYY-MM-DD"
                                    required
                                    {...form.getInputProps("signedOn")}
                                  />
                                  <DateInput
                                    label={t`Согласие действует по`}
                                    locale={i18n.locale}
                                    valueFormat="YYYY-MM-DD"
                                    required
                                    {...form.getInputProps("expiresOn")}
                                  />
                                </>
                              )}
                              <Group>
                                <Button
                                  type="submit"
                                  disabled={
                                    !workspace.canWrite() ||
                                    allowed.length === 0 ||
                                    remove.isPending
                                  }
                                  loading={save.isPending}
                                >{t`Сохранить на устройстве`}</Button>
                                <Button
                                  variant="default"
                                  disabled={save.isPending}
                                  onClick={() =>
                                    replace(() => {
                                      editor.close();
                                      form.reset();
                                    })
                                  }
                                >{t`Отмена`}</Button>
                              </Group>
                            </Stack>
                          </form>
                        </Paper>
                      )}
                    {records.length === 0 && source.isReady && (
                      <Text>{t`Участие в исследованиях ещё не зарегистрировано.`}</Text>
                    )}
                    {records.map((record) => {
                      const payload = record.payload;
                      return (
                        payload?.kind === "enrollment" && (
                          <Paper key={record.clientId} withBorder p="md">
                            <Stack>
                              <Title order={3}>
                                {projectMap.get(payload.projectClientId)?.title ??
                                  payload.projectClientId}
                              </Title>
                              <Anchor
                                renderRoot={(props) => (
                                  <Link
                                    {...props}
                                    to="/m/projects/$id/enrollment"
                                    params={{ id: payload.projectClientId }}
                                  />
                                )}
                              >{t`Журнал набора клиники`}</Anchor>
                              <Anchor
                                renderRoot={(props) => (
                                  <Link
                                    {...props}
                                    to="/m/projects/$id/visits"
                                    params={{ id: payload.projectClientId }}
                                  />
                                )}
                              >{t`Визиты исследования`}</Anchor>
                              <Text>
                                {t`Версия протокола:`} {payload.protocolVersion} ·{" "}
                                {payload.protocolClientId}
                              </Text>
                              <Badge>{labels[payload.events.at(-1)!.status]}</Badge>
                              {payload.events.map((event) => (
                                <Paper key={event.id} withBorder p="sm">
                                  <Stack gap="xs">
                                    <Text fw={600}>
                                      {event.occurredOn} · {labels[event.status]}
                                    </Text>
                                    <Text>{event.reason}</Text>
                                    <Text size="sm">
                                      {t`Автор записи:`} {event.recordedBy} ·{" "}
                                      {i18n.date(event.recordedAt, {
                                        dateStyle: "medium",
                                        timeStyle: "short",
                                      })}
                                    </Text>
                                    {event.eligibilityEvidence && (
                                      <Text>{event.eligibilityEvidence}</Text>
                                    )}
                                    {event.consent && (
                                      <>
                                        <Text>
                                          {t`Документ согласия:`} {event.consent.documentReference}{" "}
                                          · {event.consent.version}
                                        </Text>
                                        <Text>
                                          {event.consent.signedOn} — {event.consent.expiresOn}
                                        </Text>
                                        {event.consent.expiresOn <
                                          new Date().toISOString().slice(0, 10) && (
                                          <Alert color="yellow">{t`Срок согласия истёк. Запись сохраняет историю включения и не разрешает новые исследовательские процедуры.`}</Alert>
                                        )}
                                      </>
                                    )}
                                  </Stack>
                                </Paper>
                              ))}
                              <Group>
                                {enrollmentTransitions[payload.events.at(-1)!.status].length >
                                  0 && (
                                  <Button
                                    variant="default"
                                    disabled={
                                      !workspace.canWrite() || save.isPending || remove.isPending
                                    }
                                    onClick={() => replace(() => advance(record))}
                                  >{t`Зафиксировать решение`}</Button>
                                )}
                                <Button
                                  color="red"
                                  variant="light"
                                  disabled={
                                    !workspace.canWrite() || save.isPending || remove.isPending
                                  }
                                  onClick={() =>
                                    modals.openConfirmModal({
                                      title: t`Удалить запись участия?`,
                                      children: (
                                        <Text>{t`История участия будет очищена после синхронизации. Для отказа или выбытия используйте решение, чтобы сохранить историю.`}</Text>
                                      ),
                                      labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                      onConfirm: () => remove.mutate(record),
                                    })
                                  }
                                >{t`Удалить`}</Button>
                              </Group>
                            </Stack>
                          </Paper>
                        )
                      );
                    })}
                    {failures.data?.map((failure) => (
                      <Alert key={failure.id} color="yellow">
                        <Stack>
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
          </>
        )}
      </Stack>
    </Container>
  );
}
