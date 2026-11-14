import { useLingui } from "@lingui/react/macro";
import { BarChart } from "@mantine/charts";
import {
  Checkbox,
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
  Select,
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
    comparison,
    comparisonKey,
    comparisonResult,
    comparisonStale,
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
  const comparisonReasons = {
    duplicate: t`Обнаружены повторные идентификаторы. Статистический вывод недоступен; проверьте исходный набор.`,
    overlap: t`Группы пересекаются. Критерий для независимых групп не применяется.`,
    selection: t`Сравниваемый признак участвует в отборе групп. Статистический вывод отключён.`,
    independence: t`Для статистического теста необходимо подтвердить независимость наблюдений и дизайн.`,
    empty: t`Пустой знаменатель или отсутствие вариации признака. Статистический тест недоступен.`,
    small: t`Ожидаемая частота хотя бы в одной ячейке меньше 5. Приближение χ² не применяется.`,
  };
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
    <Container component="main" py="sm">
      <Stack gap="sm">
        <Anchor component={Link} to="/m/workspace">{t`Обзор работы`}</Anchor>
        <Title>{t`Аналитика`}</Title>
        <Text>{t`Анализ доступных данных организации. Карты пациентов не изменяются.`}</Text>
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
                      <Paper key={record.clientId} withBorder p="sm">
                        <Stack gap="sm">
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
                    <Stack gap="sm">
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
                  <Paper withBorder p="sm">
                    <form onSubmit={analysisForm.onSubmit((input) => saveAnalysis.mutate(input))}>
                      <Fieldset disabled={saveAnalysis.isPending}>
                        <Stack gap="sm">
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
                          <Select
                            allowDeselect={false}
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
                          <Select
                            allowDeselect={false}
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
                          <Checkbox
                            label={t`Сравнить две когорты`}
                            {...analysisForm.getInputProps("comparisonEnabled", {
                              type: "checkbox",
                            })}
                          />
                          {analysisForm.values.comparisonEnabled && (
                            <Stack gap="sm">
                              <Title order={3}>{t`Референтная когорта`}</Title>
                              <MultiSelect
                                label={t`Диагнозы включения второй группы`}
                                searchable
                                clearable
                                data={[
                                  ...new Set([
                                    ...report.availableCodes,
                                    ...analysisForm.values.comparison.reference.include,
                                  ]),
                                ].sort()}
                                {...analysisForm.getInputProps("comparison.reference.include")}
                              />
                              <Select
                                allowDeselect={false}
                                label={t`Совпадение диагнозов включения`}
                                data={[
                                  { value: "any", label: t`Хотя бы один` },
                                  { value: "all", label: t`Все выбранные` },
                                ]}
                                {...analysisForm.getInputProps(
                                  "comparison.reference.diagnosisMatch",
                                )}
                              />
                              <MultiSelect
                                label={t`Диагнозы исключения второй группы`}
                                searchable
                                clearable
                                data={[
                                  ...new Set([
                                    ...report.availableCodes,
                                    ...analysisForm.values.comparison.reference.exclude,
                                  ]),
                                ].sort()}
                                {...analysisForm.getInputProps("comparison.reference.exclude")}
                              />
                              <Select
                                allowDeselect={false}
                                label={t`Пол второй группы`}
                                data={[
                                  { value: "any", label: t`Любой` },
                                  ...Object.entries(sexLabels).map(([value, label]) => ({
                                    value,
                                    label,
                                  })),
                                ]}
                                {...analysisForm.getInputProps("comparison.reference.sex")}
                              />
                              <Select
                                allowDeselect={false}
                                label={t`Бинарный признак`}
                                value={analysisForm.values.comparison.outcome.kind}
                                onChange={(value) =>
                                  analysisForm.setFieldValue(
                                    "comparison.outcome",
                                    (value ?? "") === "sex"
                                      ? { kind: "sex", value: "female" }
                                      : { kind: "diagnosis", code: "" },
                                  )
                                }
                                data={[
                                  { value: "diagnosis", label: t`Код диагноза записан в карте` },
                                  { value: "sex", label: t`Указанный пол` },
                                ]}
                              />
                              {analysisForm.values.comparison.outcome.kind === "diagnosis" ? (
                                <TextInput
                                  label={t`Точный код сравниваемого диагноза`}
                                  {...analysisForm.getInputProps("comparison.outcome.code")}
                                />
                              ) : (
                                <Select
                                  allowDeselect={false}
                                  label={t`Значение признака`}
                                  data={[
                                    { value: "female", label: t`Женский` },
                                    { value: "male", label: t`Мужской` },
                                  ]}
                                  {...analysisForm.getInputProps("comparison.outcome.value")}
                                />
                              )}
                              <Select
                                allowDeselect={false}
                                label={t`Доверительный уровень`}
                                value={String(analysisForm.values.comparison.confidence)}
                                onChange={(value) =>
                                  analysisForm.setFieldValue(
                                    "comparison.confidence",
                                    Number(value ?? "") as 90 | 95 | 99,
                                  )
                                }
                                data={["90", "95", "99"]}
                              />
                              <Select
                                allowDeselect={false}
                                label={t`Назначение сравнения`}
                                data={[
                                  { value: "exploratory", label: t`Разведочный анализ` },
                                  { value: "prespecified", label: t`Гипотеза определена заранее` },
                                ]}
                                {...analysisForm.getInputProps("comparison.intent")}
                              />
                              <Textarea
                                label={t`Гипотеза и обоснование дизайна`}
                                maxLength={2000}
                                {...analysisForm.getInputProps("comparison.hypothesis")}
                              />
                              <Checkbox
                                label={t`Подтверждаю независимость наблюдений и обоснованность дизайна сравнения`}
                                {...analysisForm.getInputProps("comparison.independent", {
                                  type: "checkbox",
                                })}
                              />
                              <Text>{t`Отметка о заранее определённой гипотезе является заявлением автора, а не регистрацией протокола. Кластеризация, смешивающие факторы и множественные сравнения автоматически не проверяются.`}</Text>
                              <Button
                                variant="default"
                                loading={comparison.isPending}
                                onClick={() => {
                                  if (!analysisForm.validate().hasErrors)
                                    comparison.mutate({
                                      scope: workspace.scope,
                                      key: comparisonKey,
                                    });
                                }}
                              >{t`Рассчитать сравнение`}</Button>
                              {comparison.isError && (
                                <Alert color="red">{t`Не удалось выполнить локальный расчёт. Проверьте параметры и доступ к данным.`}</Alert>
                              )}
                            </Stack>
                          )}
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
                {comparisonResult && (
                  <Paper withBorder p="sm">
                    <Stack gap="sm">
                      <Title order={2}>{t`Сравнение когорт`}</Title>
                      {comparisonStale ? (
                        <Alert color="yellow">{t`Данные или параметры изменились. Выполните расчёт повторно; предыдущий результат скрыт.`}</Alert>
                      ) : (
                        <>
                          <Text>
                            {t`Время расчёта:`}{" "}
                            {i18n.date(new Date(comparisonResult.report.calculatedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                          <Text>{t`Интервалы Клоппера — Пирсона относятся к каждой доле отдельно. Они не являются интервалами разности или отношения долей.`}</Text>
                          <Table.ScrollContainer minWidth={650}>
                            <Table>
                              <Table.Thead>
                                <Table.Tr>
                                  <Table.Th>{t`Группа`}</Table.Th>
                                  <Table.Th>{t`Выбрано`}</Table.Th>
                                  <Table.Th>{t`Признак / знаменатель`}</Table.Th>
                                  <Table.Th>{t`Доля и доверительный интервал`}</Table.Th>
                                  <Table.Th>{t`Недоступно / не указано`}</Table.Th>
                                </Table.Tr>
                              </Table.Thead>
                              <Table.Tbody>
                                {comparisonResult.report.groups.map((group, index) => (
                                  <Table.Tr key={index}>
                                    <Table.Td>
                                      {index === 0 ? t`Основная` : t`Референтная`}
                                    </Table.Td>
                                    <Table.Td>{group.selected}</Table.Td>
                                    <Table.Td>
                                      {group.positive} / {group.total}
                                    </Table.Td>
                                    <Table.Td>
                                      {group.interval
                                        ? [
                                            group.interval.proportion,
                                            group.interval.lower,
                                            group.interval.upper,
                                          ]
                                            .map((value) =>
                                              i18n.number(value, {
                                                style: "percent",
                                                maximumFractionDigits: 2,
                                              }),
                                            )
                                            .join(" / ")
                                        : "—"}
                                    </Table.Td>
                                    <Table.Td>
                                      {group.unavailable} / {group.unknown}
                                    </Table.Td>
                                  </Table.Tr>
                                ))}
                              </Table.Tbody>
                            </Table>
                          </Table.ScrollContainer>
                          <Text>
                            {t`Описательная разность долей, процентные пункты:`}{" "}
                            {comparisonResult.report.difference === null
                              ? "—"
                              : i18n.number(comparisonResult.report.difference * 100, {
                                  maximumFractionDigits: 2,
                                })}
                          </Text>
                          <Text>
                            {t`Описательное отношение долей:`}{" "}
                            {comparisonResult.report.ratio === null
                              ? "—"
                              : i18n.number(comparisonResult.report.ratio, {
                                  maximumFractionDigits: 3,
                                })}
                          </Text>
                          {comparisonResult.report.reason && (
                            <Alert>{comparisonReasons[comparisonResult.report.reason]}</Alert>
                          )}
                          {comparisonResult.report.test && (
                            <Text>
                              {t`Критерий χ² с поправкой Йейтса, df = 1; p-value:`}{" "}
                              {comparisonResult.report.test.pValue < 0.000001
                                ? "< 0.000001"
                                : i18n.number(comparisonResult.report.test.pValue, {
                                    maximumFractionDigits: 6,
                                  })}
                            </Text>
                          )}
                          <Alert>{t`Сравниваются записи в разрешённых локальных данных, а не риск заболевания в популяции. Пустой список диагнозов означает отсутствие записанного кода, а не отсутствие заболевания. Результат не доказывает причинность и не является рекомендацией по лечению. При повторных проверках возрастает вероятность случайных находок.`}</Alert>
                        </>
                      )}
                    </Stack>
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
