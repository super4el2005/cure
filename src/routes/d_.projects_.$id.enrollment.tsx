import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
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
  Title,
} from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

import { enrollmentStatusSchema } from "@/src/lib/study-enrollment-model";
import { useEnrollmentRegister } from "@/src/lib/use-enrollment-register";
import { useRecruitmentJournal } from "@/src/lib/use-recruitment-journal";

export const Route = createFileRoute("/d_/projects_/$id/enrollment")({ component: Recruitment });
function Recruitment() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const space = useEnrollmentRegister(id);
  const journal = useRecruitmentJournal(id, space.userId, space.online);
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
    source,
    all,
    selected,
    filters,
    page,
    pageCount,
    pagination,
    pageRows,
    counts,
  } = space;
  const labels = {
    screening: t`Скрининг`,
    ineligible: t`Критерии не выполнены`,
    enrolled: t`Включён`,
    declined: t`Отказ`,
    withdrawn: t`Выбытие`,
    completed: t`Участие завершено`,
  };
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
        <Title>{t`Журнал набора клиники`}</Title>
        <Text>
          {t`Исследование:`} {id}
        </Text>
        {!userId && (
          <Alert>{t`Войдите и подтвердите принадлежность к организации, чтобы работать с пациентами.`}</Alert>
        )}
        {userId && (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Title order={2}>{t`Межцентровый журнал набора`}</Title>
              <Alert>{t`Агрегированные показатели центров по подтверждённым сервером записям участия. Персональные данные, даты событий, причины решений и документы согласия не покидают клиники. Изменения, ожидающие отправки из локального пространства, попадут в обзор после синхронизации.`}</Alert>
              {!online ? (
                <Alert>{t`Межцентровый журнал требует сети и активной сессии.`}</Alert>
              ) : journal.centers.isPending ? (
                <Text>{t`Загрузка показателей центров…`}</Text>
              ) : journal.centers.data === null ? (
                <Alert>{t`Межцентровый журнал доступен участникам команды исследования.`}</Alert>
              ) : journal.centers.isError ? (
                <Alert color="red">{t`Не удалось загрузить показатели центров. Повторите попытку позже.`}</Alert>
              ) : (
                <>
                  <Group>
                    {enrollmentStatusSchema.options.map((status) => (
                      <Badge key={status}>
                        {labels[status]}: {i18n.number(journal.totals.counts[status])}
                      </Badge>
                    ))}
                    <Badge color="yellow">
                      {t`Истёкшее согласие`}: {i18n.number(journal.totals.consentExpired)}
                    </Badge>
                  </Group>
                  {journal.rows.length === 0 ? (
                    <Text>{t`Подтверждённых записей участия пока нет.`}</Text>
                  ) : (
                    <Table.ScrollContainer minWidth={800}>
                      <Table captionSide="top">
                        <Table.Caption>{t`Текущие состояния набора по центрам исследования`}</Table.Caption>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t`Центр`}</Table.Th>
                            {enrollmentStatusSchema.options.map((status) => (
                              <Table.Th key={status}>{labels[status]}</Table.Th>
                            ))}
                            <Table.Th>{t`Всего`}</Table.Th>
                            <Table.Th>{t`Истёкшее согласие`}</Table.Th>
                            <Table.Th>{t`Обновлено (UTC)`}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {journal.rows.map((row) => (
                            <Table.Tr key={row.organizationId}>
                              <Table.Td>
                                {row.name || row.organizationId}
                                <Text size="xs">
                                  {[row.city, row.country].filter(Boolean).join(", ")}
                                </Text>
                              </Table.Td>
                              {enrollmentStatusSchema.options.map((status) => (
                                <Table.Td key={status}>{i18n.number(row.counts[status])}</Table.Td>
                              ))}
                              <Table.Td>{i18n.number(row.total)}</Table.Td>
                              <Table.Td>{i18n.number(row.consentExpired)}</Table.Td>
                              <Table.Td>
                                {new Date(row.updatedAt).toISOString().slice(0, 10)}
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                </>
              )}
            </Stack>
          </Paper>
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
          <Alert color="red">{t`Не удалось открыть локальные данные. Проверьте организацию, парольную фразу и срок доступа.`}</Alert>
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
              <Alert>{t`Журнал пациентов клиники доступен только врачу. Участие в команде исследования не открывает персональные данные или показатели набора клиники.`}</Alert>
            ) : (
              <>
                <Alert>{t`Показаны только записи выбранной клиники из подготовленного локального набора, включая ещё не отправленные изменения; межцентровый обзор выше собирается отдельно на сервере. Счётчики отражают текущие статусы до применения фильтров.`}</Alert>
                {!downloaded.isReady || !source.isReady ? (
                  <Text>{t`Загрузка локальных данных…`}</Text>
                ) : (
                  <>
                    <Text>
                      {t`Записей участия:`} {i18n.number(all.length)}
                    </Text>
                    <Group>
                      {counts.map((item) => (
                        <Badge key={item.status}>
                          {labels[item.status]}: {i18n.number(item.count)}
                        </Badge>
                      ))}
                    </Group>
                    <TextInput
                      label={t`Поиск по имени или идентификатору пациента`}
                      maxLength={200}
                      value={filters.values.query}
                      onChange={(event) => {
                        filters.setFieldValue("query", event.currentTarget.value);
                        pagination.setPage(1);
                      }}
                    />
                    <MultiSelect
                      label={t`Статусы участия`}
                      data={enrollmentStatusSchema.options.map((value) => ({
                        value,
                        label: labels[value],
                      }))}
                      value={filters.values.statuses}
                      onChange={(values) => {
                        filters.setFieldValue(
                          "statuses",
                          enrollmentStatusSchema.array().parse(values),
                        );
                        pagination.setPage(1);
                      }}
                    />
                    <Checkbox
                      label={t`Только включённые пациенты с истёкшим согласием`}
                      checked={filters.values.expiredOnly}
                      onChange={(event) => {
                        filters.setFieldValue("expiredOnly", event.currentTarget.checked);
                        pagination.setPage(1);
                      }}
                    />
                    <Text>
                      {t`Найдено:`} {i18n.number(selected.length)}
                    </Text>
                    {selected.length === 0 && (
                      <Text>{t`Нет записей участия по выбранным условиям.`}</Text>
                    )}
                    <Table.ScrollContainer minWidth={800}>
                      <Table captionSide="top">
                        <Table.Caption>{t`Текущие решения по пациентам выбранной клиники`}</Table.Caption>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t`Пациент`}</Table.Th>
                            <Table.Th>{t`Решение`}</Table.Th>
                            <Table.Th>{t`Дата события (UTC)`}</Table.Th>
                            <Table.Th>{t`Причина и обоснование решения`}</Table.Th>
                            <Table.Th>{t`Согласие действует по`}</Table.Th>
                            <Table.Th>{t`Протокол`}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {pageRows.map((row) => (
                            <Table.Tr key={row.clientId}>
                              <Table.Td>
                                <Anchor
                                  renderRoot={(props) => (
                                    <Link
                                      {...props}
                                      to="/d/patients/$id/enrollment"
                                      params={{ id: row.patientClientId }}
                                    />
                                  )}
                                >
                                  {row.fullName}
                                </Anchor>
                                <Text size="xs">{row.patientClientId}</Text>
                              </Table.Td>
                              <Table.Td>
                                <Badge>{labels[row.status]}</Badge>
                              </Table.Td>
                              <Table.Td>{row.decisionOn}</Table.Td>
                              <Table.Td>{row.reason}</Table.Td>
                              <Table.Td>
                                {row.consentExpiresOn ?? "—"}
                                {row.consentExpired && (
                                  <Badge color="yellow">{t`Согласие истекло`}</Badge>
                                )}
                              </Table.Td>
                              <Table.Td>{row.protocolVersion}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                    <Pagination total={pageCount} value={page} onChange={pagination.setPage} />
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
