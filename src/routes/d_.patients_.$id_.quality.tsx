import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  Select,
  Paper,
  Pagination,
  PasswordInput,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { usePagination } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { clinicalHistoryContent } from "@/src/lib/clinical-history-content";
import { dataQualityContent } from "@/src/lib/data-quality-content";
import { usePatientDataQuality } from "@/src/lib/use-patient-data-quality";
import { failureDetails } from "@/src/observability/events";

export const Route = createFileRoute("/d_/patients_/$id_/quality")({
  component: PatientDataQuality,
});
function PatientDataQuality() {
  const { id } = Route.useParams();
  const { t, i18n } = useLingui();
  const {
    workspace,
    opened,
    userId,
    online,
    status,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    patient,
    canCheck,
    check,
    result,
    stale,
    reviewForm,
    formCurrent,
    formStale,
    failures,
    save,
    restore,
    dismiss,
    prepare,
    begin,
    reviews,
    records,
    names,
    blocker,
  } = usePatientDataQuality(id);
  const labels = dataQualityContent(i18n);
  const byRecordId = new Map(records.map((row) => [row.clientId, row]));
  const levels = {
    documentation: t`Недокументированные сведения`,
    review: t`Для сверки врачом`,
    followUp: t`Состояние или срок требует уточнения`,
  };
  const decisions = {
    needsClarification: t`Требует уточнения`,
    reviewedAsRecorded: t`Проверено как записано`,
  };
  const busy = save.isPending || restore.isPending || prepare.isPending || dismiss.isPending;
  const errorCodes = [check, save, restore, prepare, dismiss]
    .filter((operation) => operation.isError)
    .map((operation) => failureDetails(operation.error).code);
  const report = stale ? undefined : result;
  const total = Math.max(1, Math.ceil((report?.findings.length ?? 0) / 25));
  const pagination = usePagination({ total });
  const activePage = Math.min(pagination.active, total);
  const reviewTotal = Math.max(1, Math.ceil(reviews.length / 25));
  const reviewPagination = usePagination({ total: reviewTotal });
  const reviewPage = Math.min(reviewPagination.active, reviewTotal);
  const rerun = () => {
    pagination.first();
    check.mutate({ scope: workspace!.scope, patientId: id });
  };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        {blocker.status === "blocked" && (
          <Modal
            opened
            onClose={blocker.reset}
            title={t`Покинуть страницу с несохранёнными изменениями?`}
          >
            <Stack gap="sm">
              <Text>{t`Изменения в редакторе не сохранены на устройстве. Вернитесь и сохраните их или подтвердите выход.`}</Text>
              <Group>
                <Button onClick={blocker.reset}>{t`Остаться`}</Button>
                <Button
                  variant="default"
                  onClick={blocker.proceed}
                >{t`Уйти без сохранения`}</Button>
              </Group>
            </Stack>
          </Modal>
        )}
        <Anchor
          renderRoot={(props) => <Link {...props} to="/d/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Качество данных карты`}</Title>
        <Text>{t`Проверка документации, без клинических рекомендаций.`}</Text>
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
          <Alert color="red">{t`Не удалось открыть или подтвердить пространство. Проверьте парольную фразу, сеть и разрешения.`}</Alert>
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
                disabled={busy}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {opened?.role !== "doctor" ? (
              <Alert>{t`Проверка полной клинической карты доступна только врачу своей организации.`}</Alert>
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
                <Alert>{t`Решения врача не исправляют карту и не скрывают сигналы.`}</Alert>
                {!status.data?.online && (
                  <Alert>{t`Проверяются подготовленные локальные данные, включая неотправленные изменения. Новые сведения и отзывы доступа других участников могут быть ещё не получены.`}</Alert>
                )}
                {!canCheck && (
                  <Alert>{t`Для проверки нужен полностью подготовленный набор карты и клинических записей с действующим сроком доступа. Частичный набор не считается полной картой.`}</Alert>
                )}
                {workspace.qualityReviewVersion !== "patient-quality-v1" && (
                  <Alert>{t`Сохранение решений недоступно в текущей версии сервера. После обновления системы переоткройте пространство онлайн. Проверка подготовленных данных доступна.`}</Alert>
                )}
                <Text>
                  {t`В очереди:`} {status.data?.pending ?? 0}
                </Text>
                <Button
                  disabled={!canCheck || busy}
                  loading={check.isPending}
                  onClick={rerun}
                >{t`Выполнить проверку данных`}</Button>
                {errorCodes.map((code, index) => (
                  <Alert key={index} color="red">
                    {code === "QUALITY_DATA_LIMIT"
                      ? t`Набор превышает лимит локальной проверки — 2000 клинических записей. Решение по неполному набору не сохраняется.`
                      : code === "QUALITY_SOURCE_CHANGED"
                        ? t`Исходные данные изменились. Повторите проверку и пересмотрите решение; введённый текст сохранён.`
                        : t`Операция не выполнена. Проверьте данные, срок доступа и обоснование решения; форма сохранена.`}
                  </Alert>
                ))}
                {stale && (
                  <Alert color="yellow">{t`Данные или контрольная дата изменились. Предыдущий отчёт скрыт до повторной проверки.`}</Alert>
                )}
                {report && (
                  <>
                    <Text>
                      {t`Контрольная дата (UTC)`}: {report.evaluationDate} —{" "}
                      {t`Записей в проверке:`} {report.sourceCount}
                    </Text>
                    <Group>
                      {Object.entries(levels).map(([level, label]) => (
                        <Badge key={level}>
                          {label}:{" "}
                          {report.findings.filter((finding) => finding.level === level).length}
                        </Badge>
                      ))}
                    </Group>
                    {!report.findings.length && (
                      <Alert>{t`По этим правилам сигналов не найдено. Это не подтверждает отсутствие ошибок, заболеваний или недостающих обследований.`}</Alert>
                    )}
                    {report.findings
                      .slice((activePage - 1) * 25, activePage * 25)
                      .map((finding) => (
                        <Paper key={finding.key} withBorder p="sm">
                          <Stack gap="sm">
                            <Badge>{levels[finding.level]}</Badge>
                            <Title order={3}>{labels[finding.code].title}</Title>
                            <Text>{labels[finding.code].description}</Text>
                            <Text>
                              {t`Связанных записей:`} {finding.recordIds.length}
                            </Text>
                            {finding.fields.length > 0 && (
                              <Text>
                                {t`Полей для сверки:`} {finding.fields.length}
                              </Text>
                            )}
                            <Accordion>
                              {finding.recordIds.map((recordId) => {
                                const row = byRecordId.get(recordId);
                                if (!row?.payload) return null;
                                const content = clinicalHistoryContent(row.payload, i18n, names);
                                return (
                                  <Accordion.Item key={recordId} value={recordId}>
                                    <Accordion.Control>
                                      {content.title} — {row.payload.occurredOn} — {t`Редакция`}{" "}
                                      {row.revision}
                                    </Accordion.Control>
                                    <Accordion.Panel>
                                      <Table>
                                        <Table.Tbody>
                                          {content.rows.map(([label, value], index) => (
                                            <Table.Tr key={index}>
                                              <Table.Th>{label}</Table.Th>
                                              <Table.Td>{value}</Table.Td>
                                            </Table.Tr>
                                          ))}
                                        </Table.Tbody>
                                      </Table>
                                    </Accordion.Panel>
                                  </Accordion.Item>
                                );
                              })}
                            </Accordion>
                            <Button
                              variant="default"
                              disabled={
                                busy ||
                                !workspace.canWrite() ||
                                workspace.qualityReviewVersion !== "patient-quality-v1"
                              }
                              onClick={() => {
                                const open = () => begin(finding);
                                if (formCurrent && reviewForm.values.notes.trim())
                                  modals.openConfirmModal({
                                    title: t`Заменить несохранённое решение?`,
                                    children: (
                                      <Text>{t`Введённое основание решения будет заменено.`}</Text>
                                    ),
                                    labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                    onConfirm: open,
                                  });
                                else open();
                              }}
                            >{t`Зафиксировать проверку врачом`}</Button>
                          </Stack>
                        </Paper>
                      ))}
                    <Pagination total={total} value={activePage} onChange={pagination.setPage} />
                  </>
                )}
                {formCurrent && (
                  <Paper withBorder p="sm">
                    <form
                      onSubmit={reviewForm.onSubmit(
                        (input) =>
                          void modals.openConfirmModal({
                            title: t`Сохранить решение для показанной версии данных?`,
                            children: (
                              <Stack gap="sm">
                                <Text>{labels[input.code].title}</Text>
                                <Text>{decisions[input.decision]}</Text>
                                <Text>{input.notes}</Text>
                                <Text>{t`Решение не исправляет карту и не подтверждает отсутствие клинических рисков. При изменении данных потребуется новая проверка.`}</Text>
                              </Stack>
                            ),
                            labels: { confirm: t`Сохранить`, cancel: t`Отмена` },
                            onConfirm: () => save.mutate(input),
                          }),
                      )}
                    >
                      <Stack gap="sm">
                        <Title order={3}>{labels[reviewForm.values.code].title}</Title>
                        {formStale && (
                          <Alert color="yellow">{t`Форма относится к прежней проверке. Скопируйте нужный текст или откройте решение для актуального сигнала; сохранение старого решения заблокировано.`}</Alert>
                        )}
                        <Select
                          allowDeselect={false}
                          label={t`Решение врача`}
                          disabled={save.isPending}
                          data={Object.entries(decisions).map(([value, label]) => ({
                            value,
                            label,
                          }))}
                          {...reviewForm.getInputProps("decision")}
                        />
                        <Textarea
                          label={t`Обоснование решения врача`}
                          autoComplete="off"
                          required
                          maxLength={2000}
                          disabled={save.isPending}
                          {...reviewForm.getInputProps("notes")}
                        />
                        <Button
                          type="submit"
                          loading={save.isPending}
                          disabled={
                            formStale ||
                            !workspace.canWrite() ||
                            workspace.qualityReviewVersion !== "patient-quality-v1"
                          }
                        >{t`Сохранить решение на устройстве`}</Button>
                        <Button
                          variant="default"
                          disabled={save.isPending}
                          onClick={() => reviewForm.reset()}
                        >{t`Отмена`}</Button>
                      </Stack>
                    </form>
                  </Paper>
                )}
                {save.isSuccess &&
                  save.variables.scope === workspace.scope &&
                  save.variables.patientId === id && (
                    <Alert color="green">{t`Решение сохранено локально. Серверная доставка проверяется по очереди; изменение исходных данных может привести к отклонению.`}</Alert>
                  )}
                {failures.isError && (
                  <Alert color="red">{t`Не удалось прочитать архив отклонённых решений.`}</Alert>
                )}
                {failures.data?.map((failure) => (
                  <Alert key={failure.id} color="yellow">
                    <Stack gap="sm">
                      <Text>{t`Сервер отклонил решение; зашифрованный черновик сохранён отдельно. Повтор не выполняется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      <Text>{labels[failure.review.code].title}</Text>
                      <Text>{failure.review.notes}</Text>
                      <Button
                        variant="default"
                        disabled={busy}
                        onClick={() =>
                          modals.openConfirmModal({
                            title: t`Удалить сохранённый черновик решения?`,
                            children: (
                              <Text>{t`Текст отклонённого решения будет удалён только с этого устройства. Карта и серверные решения не изменятся.`}</Text>
                            ),
                            labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                            onConfirm: () => dismiss.mutate(failure),
                          })
                        }
                      >{t`Удалить сохранённый черновик`}</Button>
                      <Button
                        variant="default"
                        disabled={!report || busy}
                        onClick={() =>
                          modals.openConfirmModal({
                            title: t`Открыть текст для новой проверки?`,
                            children: (
                              <Text>{t`Будет создано новое решение по актуальному сигналу, а не подтверждена старая версия данных. Если сигнала больше нет, перенос не выполняется.`}</Text>
                            ),
                            labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                            onConfirm: () => restore.mutate(failure),
                          })
                        }
                      >{t`Перенести текст в новое решение`}</Button>
                    </Stack>
                  </Alert>
                ))}
                <Title order={2}>{t`Решения врача по качеству данных`}</Title>
                {reviews.slice((reviewPage - 1) * 25, reviewPage * 25).map(
                  (row) =>
                    row.payload?.kind === "qualityReview" && (
                      <Paper key={row.clientId} withBorder p="sm">
                        <Stack gap="sm">
                          <Title order={3}>{labels[row.payload.code].title}</Title>
                          <Badge>{decisions[row.payload.decision]}</Badge>
                          <Text>
                            {report && row.payload.sourceSignature === report.sourceSignature
                              ? t`Относится к текущей проверке`
                              : t`Сверьте с новой проверкой: версия данных или контрольная дата могут отличаться`}
                          </Text>
                          <Text>{row.payload.notes}</Text>
                          <Text>
                            {t`Проверивший врач`}:{" "}
                            {names.get(row.payload.reviewedBy) ?? row.payload.reviewedBy}
                          </Text>
                          <Text>
                            {t`Контрольная дата (UTC)`}: {row.payload.evaluationDate} —{" "}
                            {t`Последнее сохранение источника:`}{" "}
                            {i18n.date(new Date(row.updatedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                        </Stack>
                      </Paper>
                    ),
                )}
                <Pagination
                  total={reviewTotal}
                  value={reviewPage}
                  onChange={reviewPagination.setPage}
                />
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
