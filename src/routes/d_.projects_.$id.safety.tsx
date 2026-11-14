import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  MultiSelect,
  Select,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useForm } from "@mantine/form";
import { useForceUpdate, useInterval } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";
import "dayjs/locale/ru";

import { issueOverdue, issueTransitions, seriousnessSchema } from "@/src/lib/study-issue-model";
import { useStudyIssues } from "@/src/lib/use-study-issues";

export const Route = createFileRoute("/d_/projects_/$id/safety")({ component: StudySafety });
function StudySafety() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  useInterval(useForceUpdate(), 30000, { autoInvoke: true });
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
    source,
    enrollments,
    cases,
    reviewers,
    reviewerOptions,
    editing,
    editor,
    form,
    selectEnrollment,
    failures,
    saveCase,
    deleteCase,
    restoreCase,
    blocker,
    start,
    editCase,
  } = useStudyIssues(id);
  const statuses = {
    open: t`Открыто`,
    underReview: t`На рассмотрении`,
    resolved: t`Рассмотрено`,
    closed: t`Закрыто`,
  };
  const categories = {
    adverseEvent: t`Нежелательное явление`,
    deviation: t`Отклонение от протокола`,
  };
  const severity = { mild: t`Лёгкая`, moderate: t`Умеренная`, severe: t`Тяжёлая` };
  const serious = {
    death: t`Смерть`,
    lifeThreatening: t`Угроза жизни в момент события`,
    hospitalization: t`Госпитализация или её продление`,
    disability: t`Стойкая или значительная нетрудоспособность`,
    congenitalAnomaly: t`Врождённая аномалия`,
    medicallyImportant: t`Другое медицински значимое событие`,
  };
  const causality = {
    unassessed: t`Не оценена`,
    unrelated: t`Связь отсутствует`,
    possible: t`Возможная связь`,
    probable: t`Вероятная связь`,
    related: t`Связь установлена врачом`,
  };
  const expectedness = {
    unknown: t`Не оценена`,
    expected: t`Ожидаемое`,
    unexpected: t`Неожиданное`,
  };
  const outcomes = {
    unknown: t`Неизвестен`,
    ongoing: t`Продолжается`,
    recovering: t`Улучшение`,
    recovered: t`Выздоровление`,
    sequelae: t`Выздоровление с последствиями`,
    fatal: t`Летальный исход`,
  };
  const impacts = { minor: t`Незначительное`, major: t`Значительное`, critical: t`Критическое` };
  const filter = useForm({
    initialValues: { category: "all", status: "all", overdue: false, query: "" },
  });
  const visible = cases.filter(
    (row) =>
      row.payload?.kind === "studyIssue" &&
      (filter.values.category === "all" || row.payload.details.type === filter.values.category) &&
      (filter.values.status === "all" || row.payload.status === filter.values.status) &&
      (!filter.values.overdue || issueOverdue(row.payload, Date.now())) &&
      `${row.payload.title} ${row.payload.description} ${rows.find((patient) => patient.clientId === row.patientClientId)?.fullName ?? ""}`
        .toLowerCase()
        .includes(filter.values.query.trim().toLowerCase()),
  );
  if (
    form.values.reviewerId &&
    !reviewerOptions.some((row) => row.value === form.values.reviewerId)
  )
    reviewerOptions.push({ value: form.values.reviewerId, label: form.values.reviewerId });
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
        <Title>{t`Безопасность и отклонения исследования`}</Title>
        <Text>
          {t`Исследование:`} {id}
        </Text>
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
          reviewers.isError ||
          saveCase.isError ||
          deleteCase.isError ||
          restoreCase.isError ||
          failures.isError) && (
          <Alert color="red">{t`Не удалось сохранить или загрузить событие. Проверьте роль врача, участника, назначенного ответственного, даты и версию записи. Ввод остаётся в редакторе.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Button
                variant="default"
                loading={lock.isPending}
                disabled={saveCase.isPending || deleteCase.isPending}
                onClick={() => replace(() => lock.mutate())}
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
              <Alert>{t`Медицинские события доступны только врачу клиники. Проектная роль и согласие на пол и диагнозы не открывают эти записи исследователю.`}</Alert>
            ) : (
              <>
                <Alert>{t`Показана выбранная клиника. Врач может фиксировать события после выбытия пациента и закрытия проекта. Рассмотрение выполняет назначенный врач клиники. Срок вводится по правилам исследования; внешние уведомления не отправляются автоматически.`}</Alert>
                <Text>{t`Тяжесть симптомов и критерии серьёзности оцениваются отдельно. Причинную связь и ожидаемость определяет врач; приложение не устанавливает их автоматически.`}</Text>
                {(!source.isReady || !downloaded.isReady) && (
                  <Text>{t`Загрузка локальных данных…`}</Text>
                )}
                <Button
                  disabled={
                    !workspace.canWrite() ||
                    !source.isReady ||
                    !enrollments.length ||
                    saveCase.isPending ||
                    deleteCase.isPending
                  }
                  onClick={() => replace(start)}
                >{t`Зарегистрировать событие`}</Button>
                {source.isReady && !enrollments.length && (
                  <Alert>{t`Для регистрации нужна сохранённая запись участия пациента в этом исследовании. Действующее включение не требуется для фиксации события после выбытия.`}</Alert>
                )}
                {saveCase.isSuccess && (
                  <Alert color="green">{t`Событие сохранено в очереди устройства. Сервер повторно проверит права и версию при синхронизации.`}</Alert>
                )}
                {editing &&
                  form.values.scope === workspace.scope &&
                  form.values.projectId === id && (
                    <Paper withBorder p="sm">
                      <form onSubmit={form.onSubmit((input) => saveCase.mutate(input))}>
                        <Stack gap="sm">
                          <Title order={2}>{t`Карточка события`}</Title>
                          {(form.errors.details || form.errors._form) && (
                            <Alert color="red">{form.errors.details ?? form.errors._form}</Alert>
                          )}
                          {form.values.failureId && (
                            <Alert color="yellow">{t`Открыт отклонённый черновик. Сравните его с текущими данными перед сохранением.`}</Alert>
                          )}
                          {form.values.failureId && !form.values.original && (
                            <Alert color="yellow">{t`Исходная запись отсутствует. Для создания нового события выберите статус «Открыто»; прежнее рассмотрение не переносится.`}</Alert>
                          )}
                          {!form.values.clientId ? (
                            <Select
                              label={t`Участник исследования`}
                              required
                              allowDeselect={false}
                              value={form.values.enrollmentClientId}
                              onChange={selectEnrollment}
                              data={enrollments.map((row) => ({
                                value: row.clientId,
                                label:
                                  rows.find((patient) => patient.clientId === row.patientClientId)
                                    ?.fullName ?? row.patientClientId,
                              }))}
                            />
                          ) : (
                            <Text>
                              {rows.find((row) => row.clientId === form.values.patientClientId)
                                ?.fullName ?? form.values.patientClientId}
                            </Text>
                          )}
                          <Select
                            label={t`Вид события`}
                            disabled={Boolean(form.values.clientId)}
                            allowDeselect={false}
                            data={Object.entries(categories).map(([value, label]) => ({
                              value,
                              label,
                            }))}
                            {...form.getInputProps("category")}
                          />
                          <TextInput
                            label={t`Краткое название события`}
                            required
                            maxLength={200}
                            {...form.getInputProps("title")}
                          />
                          <Textarea
                            label={t`Описание события`}
                            required
                            maxLength={10000}
                            {...form.getInputProps("description")}
                          />
                          <DateInput
                            label={t`Дата возникновения (UTC)`}
                            required
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("occurredOn")}
                          />
                          <DateInput
                            label={t`Дата обнаружения (UTC)`}
                            required
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("detectedOn")}
                          />
                          {form.values.category === "adverseEvent" ? (
                            <>
                              <Select
                                label={t`Тяжесть симптомов`}
                                allowDeselect={false}
                                data={Object.entries(severity).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...form.getInputProps("severity")}
                              />
                              <MultiSelect
                                label={t`Критерии серьёзности`}
                                description={t`Оставьте пустым, если критерии серьёзного события отсутствуют.`}
                                data={Object.entries(serious).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                value={form.values.seriousness}
                                onChange={(values) =>
                                  form.setFieldValue(
                                    "seriousness",
                                    seriousnessSchema.array().parse(values),
                                  )
                                }
                              />
                              <Select
                                label={t`Причинная связь с исследуемым воздействием`}
                                allowDeselect={false}
                                data={Object.entries(causality).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...form.getInputProps("causality")}
                              />
                              <Select
                                label={t`Ожидаемость`}
                                allowDeselect={false}
                                data={Object.entries(expectedness).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...form.getInputProps("expectedness")}
                              />
                              <TextInput
                                label={t`Подозреваемый препарат или воздействие`}
                                maxLength={500}
                                {...form.getInputProps("suspectAgent")}
                              />
                              <Textarea
                                label={t`Предпринятые действия`}
                                required
                                maxLength={3000}
                                {...form.getInputProps("actionTaken")}
                              />
                              <Select
                                label={t`Исход явления`}
                                allowDeselect={false}
                                data={Object.entries(outcomes).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...form.getInputProps("outcome")}
                              />
                              <DateInput
                                label={t`Дата исхода (UTC)`}
                                locale={i18n.locale}
                                valueFormat="YYYY-MM-DD"
                                {...form.getInputProps("endedOn")}
                              />
                            </>
                          ) : (
                            <>
                              <Select
                                label={t`Значимость отклонения`}
                                allowDeselect={false}
                                data={Object.entries(impacts).map(([value, label]) => ({
                                  value,
                                  label,
                                }))}
                                {...form.getInputProps("impact")}
                              />
                              <TextInput
                                label={t`Раздел или требование протокола`}
                                required
                                maxLength={1000}
                                {...form.getInputProps("protocolSection")}
                              />
                              <Textarea
                                label={t`Коренная причина`}
                                maxLength={3000}
                                {...form.getInputProps("rootCause")}
                              />
                              <Textarea
                                label={t`Корректирующие действия или обоснование их отсутствия`}
                                maxLength={5000}
                                {...form.getInputProps("correctiveAction")}
                              />
                              <Textarea
                                label={t`Предупреждающие действия или обоснование их отсутствия`}
                                maxLength={5000}
                                {...form.getInputProps("preventiveAction")}
                              />
                            </>
                          )}
                          <Select
                            label={t`Ответственный врач за рассмотрение`}
                            required
                            allowDeselect={false}
                            searchable
                            data={reviewerOptions}
                            {...form.getInputProps("reviewerId")}
                          />
                          <DateInput
                            label={t`Срок рассмотрения (UTC)`}
                            required
                            locale={i18n.locale}
                            valueFormat="YYYY-MM-DD"
                            {...form.getInputProps("reviewDueOn")}
                          />
                          <Select
                            label={t`Статус рассмотрения`}
                            allowDeselect={false}
                            data={(form.values.original
                              ? issueTransitions[form.values.original.status]
                              : ["open" as const]
                            ).map((value) => ({ value, label: statuses[value] }))}
                            {...form.getInputProps("status")}
                          />
                          {["resolved", "closed"].includes(form.values.status) && (
                            <>
                              <DateInput
                                label={t`Дата рассмотрения (UTC)`}
                                required
                                locale={i18n.locale}
                                valueFormat="YYYY-MM-DD"
                                {...form.getInputProps("reviewedOn")}
                              />
                              <Textarea
                                label={t`Заключение и решение`}
                                required
                                maxLength={5000}
                                {...form.getInputProps("resolution")}
                              />
                            </>
                          )}
                          <Textarea
                            label={t`Примечания`}
                            maxLength={2000}
                            {...form.getInputProps("notes")}
                          />
                          {form.values.original &&
                            (["resolved", "closed"].includes(form.values.original.status) ||
                              (form.values.original.status === "underReview" &&
                                form.values.status === "open")) && (
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
                              loading={saveCase.isPending}
                              disabled={!workspace.canWrite() || deleteCase.isPending}
                            >{t`Сохранить на устройстве`}</Button>
                            <Button
                              variant="default"
                              disabled={saveCase.isPending}
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
                <TextInput
                  label={t`Поиск по пациенту и событию`}
                  {...filter.getInputProps("query")}
                />
                <Select
                  label={t`Вид события`}
                  allowDeselect={false}
                  data={[
                    { value: "all", label: t`Все виды` },
                    ...Object.entries(categories).map(([value, label]) => ({ value, label })),
                  ]}
                  {...filter.getInputProps("category")}
                />
                <Select
                  label={t`Статус рассмотрения`}
                  allowDeselect={false}
                  data={[
                    { value: "all", label: t`Все статусы` },
                    ...Object.entries(statuses).map(([value, label]) => ({ value, label })),
                  ]}
                  {...filter.getInputProps("status")}
                />
                <Select
                  label={t`Срок рассмотрения`}
                  allowDeselect={false}
                  data={[
                    { value: "all", label: t`Все сроки` },
                    { value: "overdue", label: t`Только просроченные` },
                  ]}
                  value={filter.values.overdue ? "overdue" : "all"}
                  onChange={(value) => filter.setFieldValue("overdue", value === "overdue")}
                />
                {source.isReady && visible.length === 0 && (
                  <Text>{t`Событий по выбранным условиям нет.`}</Text>
                )}
                {visible.map((row) => {
                  const value = row.payload;
                  if (value?.kind !== "studyIssue") return null;
                  return (
                    <Paper key={row.clientId} withBorder p="sm">
                      <Stack gap="sm">
                        <Anchor
                          renderRoot={(props) => (
                            <Link
                              {...props}
                              to="/d/patients/$id/enrollment"
                              params={{ id: row.patientClientId }}
                            />
                          )}
                        >
                          {rows.find((patient) => patient.clientId === row.patientClientId)
                            ?.fullName ?? row.patientClientId}
                        </Anchor>
                        <Title order={3}>{value.title}</Title>
                        <Group>
                          <Badge>{categories[value.details.type]}</Badge>
                          <Badge>{statuses[value.status]}</Badge>
                          {issueOverdue(value, Date.now()) && (
                            <Badge color="red">{t`Срок рассмотрения прошёл`}</Badge>
                          )}
                        </Group>
                        <Text>{value.description}</Text>
                        <Text>
                          {t`Возникновение / обнаружение (UTC):`} {value.occurredOn} /{" "}
                          {value.detectedOn}
                        </Text>
                        {value.details.type === "adverseEvent" ? (
                          <>
                            <Text>
                              {t`Тяжесть симптомов`}: {severity[value.details.severity]}
                            </Text>
                            <Text>
                              {t`Критерии серьёзности`}:{" "}
                              {value.details.seriousness.map((item) => serious[item]).join("; ") ||
                                t`Отсутствуют`}
                            </Text>
                            <Text>
                              {causality[value.details.causality]} ·{" "}
                              {expectedness[value.details.expectedness]}
                            </Text>
                            <Text>{value.details.suspectAgent}</Text>
                            <Text>{value.details.actionTaken}</Text>
                            <Text>
                              {outcomes[value.details.outcome]} {value.details.endedOn}
                            </Text>
                          </>
                        ) : (
                          <>
                            <Text>
                              {impacts[value.details.impact]} · {value.details.protocolSection}
                            </Text>
                            <Text>
                              {t`Коренная причина`}: {value.details.rootCause}
                            </Text>
                            <Text>
                              {t`Корректирующие действия или обоснование их отсутствия`}:{" "}
                              {value.details.correctiveAction}
                            </Text>
                            <Text>
                              {t`Предупреждающие действия или обоснование их отсутствия`}:{" "}
                              {value.details.preventiveAction}
                            </Text>
                          </>
                        )}
                        <Text>
                          {t`Срок рассмотрения (UTC)`}: {value.reviewDueOn}
                        </Text>
                        <Text>
                          {t`Ответственный врач за рассмотрение`}:{" "}
                          {reviewerOptions.find((item) => item.value === value.reviewerId)?.label ??
                            value.reviewerId}
                        </Text>
                        {value.resolution && (
                          <>
                            <Text>{value.resolution}</Text>
                            <Text>
                              {value.reviewedOn} · {value.reviewedBy}
                            </Text>
                          </>
                        )}
                        <Text>{value.notes}</Text>
                        {value.amendmentReason && (
                          <Text>
                            {t`Причина исправления`}: {value.amendmentReason}
                          </Text>
                        )}
                        <Text size="sm">
                          {t`Версия протокола:`} {value.protocolVersion} · {value.protocolClientId}
                        </Text>
                        <Group>
                          <Button
                            variant="default"
                            disabled={
                              !workspace.canWrite() || saveCase.isPending || deleteCase.isPending
                            }
                            onClick={() => replace(() => editCase(row))}
                          >{t`Изменить событие`}</Button>
                          <Button
                            color="red"
                            variant="light"
                            disabled={
                              !workspace.canWrite() || saveCase.isPending || deleteCase.isPending
                            }
                            onClick={() =>
                              modals.openConfirmModal({
                                title: t`Удалить событие?`,
                                children: (
                                  <Text>{t`Клиническое содержимое будет очищено после синхронизации. Метаданные удаления останутся в аудите.`}</Text>
                                ),
                                labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                onConfirm: () => deleteCase.mutate(row),
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
                          disabled={saveCase.isPending}
                          onClick={() => replace(() => restoreCase.mutate(failure))}
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
