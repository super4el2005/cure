import { useLingui } from "@lingui/react/macro";
import { BarChart } from "@mantine/charts";
import {
  Fieldset,
  TextInput,
  Textarea,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  MultiSelect,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { analyzeCohort, defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { useSavedAnalyses } from "@/src/lib/use-saved-analyses";

export const Route = createFileRoute("/m_/analytics")({ component: Analytics });
function Analytics() {
  const { t, i18n } = useLingui();
  const {
    userId,
    workspace,
    opened,
    rows,
    downloaded,
    status,
    online,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    analyses,
    localAnalyses,
    analysisForm,
    currentAnalysis,
    criteria,
    analysisFailures,
    saveAnalysis,
    deleteAnalysis,
    restoreAnalysis,
    newAnalysis,
    loadAnalysis,
  } = useSavedAnalyses();
  const report = analyzeCohort(rows, opened?.role ?? "researcher", criteria, Date.now());
  const sexLabels = { female: t`Женский`, male: t`Мужской`, unknown: t`Не указан` };
  const selectionSteps = [
    { label: t`Доступно записей до отбора`, value: report.flow.available },
    { label: t`Исключено: нет разрешения на поля критериев`, value: report.flow.unavailableFields },
    { label: t`Исключено: не соответствует полу`, value: report.flow.sex },
    { label: t`Исключено: диагноз из списка исключения`, value: report.flow.excluded },
    { label: t`Исключено: не соответствует диагнозам включения`, value: report.flow.inclusion },
    { label: t`Включено в выборку`, value: report.flow.selected },
  ];
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m/workspace">{t`Обзор работы`}</Anchor>
        <Title>{t`Аналитика`}</Title>
        <Text>{t`Описательный анализ доступных записей выбранной организации. Изменение критериев не изменяет карты пациентов.`}</Text>
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
        {(unlock.isError || lock.isError || resume.isError) && (
          <Alert color="red">{t`Не удалось открыть или подтвердить пространство. Проверьте парольную фразу, сеть и разрешения.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Badge>{opened.role === "doctor" ? t`Врач` : t`Исследователь: только чтение`}</Badge>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
                loading={lock.isPending}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {!status.data?.online && (
              <Alert>
                {t`Расчёт выполнен по локальным данным. Без синхронизации изменения других участников и новые отзывы доступа могут быть ещё не получены.`}
                <Button
                  variant="default"
                  disabled={!online}
                  loading={resume.isPending}
                  onClick={() => resume.mutate()}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            <Text>{t`В очереди: ${status.data?.pending ?? 0}`}</Text>
            {!downloaded.isReady && (
              <Alert>{t`Локальный набор ещё не подготовлен. Дождитесь загрузки; это не пустая выборка.`}</Alert>
            )}
            {downloaded.isReady && (
              <>
                <Title order={2}>{t`Сохранённые анализы`}</Title>
                <Text>{t`Сохраняются название и критерии, а не копии карт или результаты. При открытии расчёт повторяется по текущим разрешённым данным.`}</Text>
                {!localAnalyses.isReady && (
                  <Text>{t`Сохранённые анализы ещё не загружены. Для первой загрузки нужен интернет.`}</Text>
                )}
                <Button
                  disabled={
                    !localAnalyses.isReady || saveAnalysis.isPending || deleteAnalysis.isPending
                  }
                  onClick={() => {
                    if (currentAnalysis && analysisForm.isDirty())
                      modals.openConfirmModal({
                        title: t`Начать другой анализ?`,
                        children: (
                          <Text>{t`Несохранённые критерии и название будут заменены. Сохранённая версия останется доступной.`}</Text>
                        ),
                        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                        onConfirm: newAnalysis,
                      });
                    else newAnalysis();
                  }}
                >{t`Новый анализ`}</Button>
                {(saveAnalysis.isError ||
                  deleteAnalysis.isError ||
                  restoreAnalysis.isError ||
                  analysisFailures.isError) && (
                  <Alert color="red">{t`Не удалось сохранить анализ. Проверьте текущую версию и доступ; введённые значения остаются в форме.`}</Alert>
                )}
                {(saveAnalysis.isSuccess || deleteAnalysis.isSuccess) && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
                {analyses.map(
                  (record) =>
                    record.values && (
                      <Paper key={record.clientId} withBorder p="md">
                        <Stack>
                          <Title order={3}>{record.values.title}</Title>
                          <Text>{record.values.description}</Text>
                          <Text>
                            {t`Версия:`} {record.revision}
                          </Text>
                          <Text>
                            {t`Обновлено:`}{" "}
                            {i18n.date(new Date(record.updatedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                          <Group>
                            <Button
                              variant="default"
                              disabled={saveAnalysis.isPending || deleteAnalysis.isPending}
                              onClick={() => {
                                if (currentAnalysis && analysisForm.isDirty())
                                  modals.openConfirmModal({
                                    title: t`Начать другой анализ?`,
                                    children: (
                                      <Text>{t`Несохранённые критерии и название будут заменены. Сохранённая версия останется доступной.`}</Text>
                                    ),
                                    labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                    onConfirm: () => loadAnalysis(record),
                                  });
                                else loadAnalysis(record);
                              }}
                            >{t`Открыть анализ`}</Button>
                            <Button
                              color="red"
                              variant="light"
                              disabled={
                                !workspace.canWrite() ||
                                saveAnalysis.isPending ||
                                deleteAnalysis.isPending
                              }
                              onClick={() =>
                                modals.openConfirmModal({
                                  title: t`Удалить сохранённый анализ?`,
                                  children: (
                                    <Text>{t`Название и критерии будут удалены после синхронизации. Карты пациентов не изменятся.`}</Text>
                                  ),
                                  labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                  onConfirm: () => deleteAnalysis.mutate(record),
                                })
                              }
                            >{t`Удалить`}</Button>
                          </Group>
                        </Stack>
                      </Paper>
                    ),
                )}
                {analysisFailures.data?.map((failure) => (
                  <Alert color="yellow" key={failure.id}>
                    <Stack>
                      <Text>{t`Сервер отклонил изменение анализа. Черновик сохранён отдельно и не применяется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      {failure.action !== "delete" ? (
                        <Button
                          variant="default"
                          disabled={saveAnalysis.isPending || deleteAnalysis.isPending}
                          onClick={() => {
                            if (currentAnalysis && analysisForm.isDirty())
                              modals.openConfirmModal({
                                title: t`Начать другой анализ?`,
                                children: (
                                  <Text>{t`Несохранённые критерии и название будут заменены. Сохранённая версия останется доступной.`}</Text>
                                ),
                                labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                onConfirm: () => restoreAnalysis.mutate(failure),
                              });
                            else restoreAnalysis.mutate(failure);
                          }}
                        >{t`Открыть сохранённый черновик`}</Button>
                      ) : (
                        <Text>{t`Удаление отклонено. Откройте актуальный анализ перед повторным удалением.`}</Text>
                      )}
                    </Stack>
                  </Alert>
                ))}
                {!currentAnalysis && (
                  <Text>{t`Показан обзор всех доступных записей. Откройте или создайте анализ, чтобы настроить критерии.`}</Text>
                )}
                {currentAnalysis && (
                  <Paper withBorder p="md">
                    <form onSubmit={analysisForm.onSubmit((input) => saveAnalysis.mutate(input))}>
                      <Fieldset disabled={saveAnalysis.isPending}>
                        <Stack>
                          <Title order={2}>{t`Критерии выборки`}</Title>
                          <TextInput
                            label={t`Название анализа`}
                            required
                            maxLength={200}
                            {...analysisForm.getInputProps("title")}
                          />
                          <Textarea
                            label={t`Описание анализа`}
                            maxLength={2000}
                            {...analysisForm.getInputProps("description")}
                          />

                          <MultiSelect
                            maxValues={100}
                            label={t`Диагнозы включения`}
                            data={[
                              ...new Set([
                                ...report.availableCodes,
                                ...criteria.include,
                                ...criteria.exclude,
                              ]),
                            ].sort()}
                            searchable
                            clearable
                            {...analysisForm.getInputProps("criteria.include")}
                          />
                          <NativeSelect
                            label={t`Совпадение диагнозов включения`}
                            data={[
                              { value: "any", label: t`Хотя бы один` },
                              { value: "all", label: t`Все выбранные` },
                            ]}
                            {...analysisForm.getInputProps("criteria.diagnosisMatch")}
                          />
                          <MultiSelect
                            maxValues={100}
                            label={t`Диагнозы исключения`}
                            data={[
                              ...new Set([
                                ...report.availableCodes,
                                ...criteria.include,
                                ...criteria.exclude,
                              ]),
                            ].sort()}
                            searchable
                            clearable
                            {...analysisForm.getInputProps("criteria.exclude")}
                          />
                          <NativeSelect
                            label={t`Пол`}
                            data={[
                              { value: "any", label: t`Любой` },
                              ...Object.entries(sexLabels).map(([value, label]) => ({
                                value,
                                label,
                              })),
                            ]}
                            {...analysisForm.getInputProps("criteria.sex")}
                          />
                          <Button
                            variant="default"
                            onClick={() =>
                              analysisForm.setFieldValue("criteria", defaultCohortCriteria)
                            }
                          >{t`Сбросить критерии`}</Button>
                          <Text>{t`Коды сравниваются целиком без учёта регистра; выбор F41 не включает F41.1 автоматически. Исключение имеет приоритет над включением.`}</Text>
                          {analysisForm.values.failureId && !analysisForm.values.clientId && (
                            <Alert>{t`Черновик сохранится как новый анализ; удалённая запись не восстанавливается автоматически.`}</Alert>
                          )}
                          <Button
                            type="submit"
                            disabled={!workspace.canWrite()}
                            loading={saveAnalysis.isPending}
                          >{t`Сохранить анализ на устройстве`}</Button>
                        </Stack>
                      </Fieldset>
                    </form>
                  </Paper>
                )}
                <Title order={2}>{t`Схема отбора`}</Title>
                <Table captionSide="top">
                  <Table.Caption>{t`Каждая исключённая запись учитывается в первом подходящем шаге; этапы не пересекаются.`}</Table.Caption>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t`Шаг`}</Table.Th>
                      <Table.Th>{t`Записей`}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {selectionSteps.map((step) => (
                      <Table.Tr key={step.label}>
                        <Table.Td>{step.label}</Table.Td>
                        <Table.Td>{i18n.number(step.value)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {report.flow.selected === 0 ? (
                  <Alert>{t`Нет записей, соответствующих текущим критериям и разрешениям.`}</Alert>
                ) : (
                  <>
                    <Title order={2}>{t`Полнота и доступность данных`}</Title>
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t`Показатель`}</Table.Th>
                          <Table.Th>{t`Записей`}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        <Table.Tr>
                          <Table.Td>{t`Разрешено анализировать пол`}</Table.Td>
                          <Table.Td>{report.sexDenominator}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>{t`Пол не указан в разрешённых данных`}</Table.Td>
                          <Table.Td>{report.sexCounts.unknown}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>{t`Пол недоступен по согласию`}</Table.Td>
                          <Table.Td>{report.unavailableSex}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>{t`Разрешено анализировать диагнозы`}</Table.Td>
                          <Table.Td>{report.diagnosisDenominator}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>{t`Список диагнозов пуст в разрешённых данных`}</Table.Td>
                          <Table.Td>{report.emptyDiagnoses}</Table.Td>
                        </Table.Tr>
                        <Table.Tr>
                          <Table.Td>{t`Диагнозы недоступны по согласию`}</Table.Td>
                          <Table.Td>{report.unavailableDiagnoses}</Table.Td>
                        </Table.Tr>
                      </Table.Tbody>
                    </Table>
                    <Title order={2}>{t`Распределение по полу`}</Title>
                    <Table>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t`Пол`}</Table.Th>
                          <Table.Th>{t`Записей`}</Table.Th>
                          <Table.Th>{t`Доля разрешённого набора`}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {Object.entries(report.sexCounts).map(([sex, count]) => (
                          <Table.Tr key={sex}>
                            <Table.Td>{sexLabels[sex as keyof typeof sexLabels]}</Table.Td>
                            <Table.Td>{count}</Table.Td>
                            <Table.Td>
                              {report.sexDenominator
                                ? i18n.number(count / report.sexDenominator, {
                                    style: "percent",
                                    maximumFractionDigits: 1,
                                  })
                                : "—"}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                    <Title order={2}>{t`Частота диагнозов`}</Title>
                    <Text>{t`Доля считается среди записей с разрешением на диагнозы, включая пустые списки. Один пациент учитывается один раз для каждого кода; сумма долей может превышать 100%.`}</Text>
                    {report.diagnoses.length > 0 && (
                      <BarChart
                        aria-label={t`Частота диагнозов`}
                        h={300}
                        data={report.diagnoses.slice(0, 20)}
                        dataKey="code"
                        series={[{ name: "count", label: t`Записей`, color: "blue.6" }]}
                        yAxisProps={{ allowDecimals: false }}
                      />
                    )}
                    <Text>{t`На графике показаны до 20 наиболее частых кодов. Полный список приведён в таблице.`}</Text>
                    <Table.ScrollContainer minWidth={400}>
                      <Table>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t`Код диагноза`}</Table.Th>
                            <Table.Th>{t`Записей`}</Table.Th>
                            <Table.Th>{t`Доля разрешённого набора`}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {report.diagnoses.map(({ code, count }) => (
                            <Table.Tr key={code}>
                              <Table.Td>{code}</Table.Td>
                              <Table.Td>{count}</Table.Td>
                              <Table.Td>
                                {i18n.number(count / report.diagnosisDenominator, {
                                  style: "percent",
                                  maximumFractionDigits: 1,
                                })}
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  </>
                )}
                <Alert>{t`Это описательная выборка доступных локальных записей, а не оценка распространённости заболевания в популяции. Отсутствие диагноза в карте не означает отсутствие заболевания. Возраст, терапия, показатели и даты наблюдения в этот анализ не включены.`}</Alert>
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
