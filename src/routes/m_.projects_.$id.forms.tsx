import { useLingui } from "@lingui/react/macro";
import {
  Modal,
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Fieldset,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
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

import { newStudyField, useStudyForms } from "@/src/lib/use-study-forms";

export const Route = createFileRoute("/m_/projects_/$id/forms")({ component: StudyForms });
function StudyForms() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    blocker,
    userId,
    workspace,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    online,
    status,
    downloaded,
    localForms,
    project,
    history,
    latest,
    editing,
    editor,
    form,
    saveForm,
    failures,
    restore,
    newForm,
    newVersion,
    canEdit,
  } = useStudyForms(id);
  const operators: Record<string, string> = {
    equals: t`Равно`,
    notEquals: t`Не равно`,
    includes: t`Содержит вариант`,
    gt: t`Больше`,
    gte: t`Больше или равно`,
    lt: t`Меньше`,
    lte: t`Меньше или равно`,
  };
  const types = {
    text: t`Текст`,
    number: t`Число`,
    date: t`Дата`,
    boolean: t`Да или нет`,
    choice: t`Один вариант`,
    multiChoice: t`Несколько вариантов`,
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
                <Button variant="default" onClick={blocker.reset}>{t`Остаться`}</Button>
                <Button color="red" onClick={blocker.proceed}>{t`Выйти без сохранения`}</Button>
              </Group>
            </Stack>
          </Modal>
        )}

        <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
        <Title>{t`Формы исследования`}</Title>
        <Text>{t`Каждое сохранение создаёт отдельную версию шаблона. Старые ответы не изменяются при редактировании формы.`}</Text>
        {!userId && (
          <Alert>{t`Войдите через Google, чтобы открыть рабочее пространство. Для первого входа нужен интернет.`}</Alert>
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
          saveForm.isError ||
          restore.isError) && (
          <Alert color="red">{t`Не удалось сохранить форму. Проверьте доступ и текущую версию; введённые данные остаются в редакторе.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
                loading={lock.isPending}
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
                  onClick={() => resume.mutate()}
                  loading={resume.isPending}
                >{t`Повторно проверить сессию и доступ`}</Button>
              </Alert>
            )}
            {!downloaded.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
            {downloaded.isReady && !project && (
              <Alert>{t`Исследование не найдено или недоступно в выбранной организации.`}</Alert>
            )}
            {project && (
              <>
                <Title order={2}>{project.title}</Title>
                <Text>{t`Изменять шаблоны могут владелец и координатор. Настройка формы не даёт права изменять данные пациентов.`}</Text>
                <Button
                  disabled={!canEdit || saveForm.isPending}
                  onClick={() => {
                    if (editing && form.isDirty())
                      modals.openConfirmModal({
                        title: t`Заменить несохранённый шаблон?`,
                        children: (
                          <Text>{t`Несохранённые вопросы будут заменены; опубликованные версии останутся доступными.`}</Text>
                        ),
                        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                        onConfirm: newForm,
                      });
                    else newForm();
                  }}
                >{t`Новая форма`}</Button>
                {!localForms.isReady && (
                  <Text>{t`Шаблоны ещё не загружены. Для первой загрузки нужен интернет.`}</Text>
                )}
                {editing &&
                  form.values.scope === workspace.scope &&
                  form.values.projectClientId === id && (
                    <Paper withBorder p="md">
                      <form onSubmit={form.onSubmit((values) => saveForm.mutate(values))}>
                        <Fieldset disabled={saveForm.isPending || !canEdit}>
                          <Stack>
                            <Title order={2}>{t`Редактор шаблона`}</Title>
                            <Text>
                              {t`Предыдущая версия:`} {form.values.expectedVersion}
                            </Text>
                            <TextInput
                              label={t`Название формы`}
                              required
                              maxLength={200}
                              {...form.getInputProps("title")}
                            />
                            <Textarea
                              label={t`Описание формы`}
                              maxLength={2000}
                              {...form.getInputProps("description")}
                            />
                            <NativeSelect
                              label={t`Доступность новой версии`}
                              data={[
                                { value: "published", label: t`Доступна для новых ответов` },
                                ...(form.values.expectedVersion > 0
                                  ? [{ value: "retired", label: t`Закрыта для новых ответов` }]
                                  : []),
                              ]}
                              {...form.getInputProps("status")}
                            />
                            {Object.keys(form.errors).length > 0 && (
                              <Alert color="red">{t`Проверьте вопросы, варианты ответа и границы значений. В форме должно быть от 1 до 50 вопросов.`}</Alert>
                            )}
                            {form.values.fields.map((field, index) => (
                              <Paper withBorder p="md" key={field.id}>
                                <Stack>
                                  <Group>
                                    <Text>
                                      {t`Вопрос`} {index + 1}
                                    </Text>
                                    <Button
                                      variant="default"
                                      disabled={index === 0}
                                      onClick={() =>
                                        form.reorderListItem("fields", {
                                          from: index,
                                          to: index - 1,
                                        })
                                      }
                                    >{t`Вверх`}</Button>
                                    <Button
                                      variant="default"
                                      disabled={index === form.values.fields.length - 1}
                                      onClick={() =>
                                        form.reorderListItem("fields", {
                                          from: index,
                                          to: index + 1,
                                        })
                                      }
                                    >{t`Вниз`}</Button>
                                    <Button
                                      color="red"
                                      variant="light"
                                      onClick={() => form.removeListItem("fields", index)}
                                    >{t`Удалить вопрос`}</Button>
                                  </Group>
                                  <NativeSelect
                                    label={t`Тип вопроса`}
                                    data={Object.entries(types).map(([value, label]) => ({
                                      value,
                                      label,
                                    }))}
                                    {...form.getInputProps(`fields.${index}.type`)}
                                  />
                                  <TextInput
                                    label={t`Текст вопроса`}
                                    required
                                    maxLength={200}
                                    {...form.getInputProps(`fields.${index}.label`)}
                                  />
                                  <Textarea
                                    label={t`Подсказка к вопросу`}
                                    maxLength={1000}
                                    {...form.getInputProps(`fields.${index}.help`)}
                                  />
                                  <Checkbox
                                    label={t`Обязательный ответ`}
                                    {...form.getInputProps(`fields.${index}.required`, {
                                      type: "checkbox",
                                    })}
                                  />

                                  <Checkbox
                                    label={t`Показывать по условию`}
                                    disabled={index === 0 && !field.visibleWhen}
                                    checked={Boolean(field.visibleWhen)}
                                    onChange={(event) =>
                                      form.setFieldValue(
                                        `fields.${index}.visibleWhen`,
                                        event.currentTarget.checked
                                          ? {
                                              mode: "all",
                                              rules: [
                                                { fieldId: "", operator: "equals", value: "" },
                                              ],
                                            }
                                          : undefined,
                                      )
                                    }
                                  />
                                  {field.visibleWhen && (
                                    <Fieldset legend={t`Условия видимости`}>
                                      <Stack>
                                        <Text>{t`Используйте только предыдущие вопросы. Скрытый, пустой или некорректный ответ не выполняет условие.`}</Text>
                                        <NativeSelect
                                          label={t`Объединение условий`}
                                          data={[
                                            { value: "all", label: t`Все условия` },
                                            { value: "any", label: t`Хотя бы одно условие` },
                                          ]}
                                          {...form.getInputProps(
                                            `fields.${index}.visibleWhen.mode`,
                                          )}
                                        />
                                        {field.visibleWhen.rules.map((rule, ruleIndex) => {
                                          const source = form.values.fields.find(
                                            (row) => row.id === rule.fieldId,
                                          );
                                          const path = `fields.${index}.visibleWhen.rules.${ruleIndex}`;
                                          return (
                                            <Paper withBorder p="sm" key={ruleIndex}>
                                              <Stack>
                                                <NativeSelect
                                                  label={t`Исходный вопрос`}
                                                  value={rule.fieldId}
                                                  data={[
                                                    { value: "", label: t`Выберите вопрос` },
                                                    ...form.values.fields
                                                      .slice(0, index)
                                                      .map((row) => ({
                                                        value: row.id,
                                                        label: row.label || t`Вопрос`,
                                                      })),
                                                  ]}
                                                  onChange={(event) => {
                                                    const source = form.values.fields.find(
                                                      (row) => row.id === event.currentTarget.value,
                                                    );
                                                    form.replaceListItem(
                                                      `fields.${index}.visibleWhen.rules`,
                                                      ruleIndex,
                                                      {
                                                        fieldId: event.currentTarget.value,
                                                        operator:
                                                          source?.type === "multiChoice"
                                                            ? "includes"
                                                            : "equals",
                                                        value:
                                                          source?.type === "boolean"
                                                            ? false
                                                            : source?.type === "number"
                                                              ? 0
                                                              : (source?.choices[0]?.value ?? ""),
                                                      },
                                                    );
                                                  }}
                                                />
                                                <NativeSelect
                                                  label={t`Сравнение`}
                                                  data={(source?.type === "multiChoice"
                                                    ? ["includes"]
                                                    : source?.type === "number"
                                                      ? [
                                                          "equals",
                                                          "notEquals",
                                                          "gt",
                                                          "gte",
                                                          "lt",
                                                          "lte",
                                                        ]
                                                      : ["equals", "notEquals"]
                                                  ).map((value) => ({
                                                    value,
                                                    label: operators[value]!,
                                                  }))}
                                                  {...form.getInputProps(`${path}.operator`)}
                                                />
                                                {source?.type === "boolean" ? (
                                                  <NativeSelect
                                                    label={t`Значение условия`}
                                                    value={String(rule.value)}
                                                    data={[
                                                      { value: "true", label: t`Да` },
                                                      { value: "false", label: t`Нет` },
                                                    ]}
                                                    onChange={(event) =>
                                                      form.setFieldValue(
                                                        `${path}.value`,
                                                        event.currentTarget.value === "true",
                                                      )
                                                    }
                                                  />
                                                ) : source?.type === "number" ? (
                                                  <NumberInput
                                                    label={t`Значение условия`}
                                                    {...form.getInputProps(`${path}.value`)}
                                                  />
                                                ) : source?.type === "choice" ||
                                                  source?.type === "multiChoice" ? (
                                                  <NativeSelect
                                                    label={t`Значение условия`}
                                                    data={source.choices}
                                                    {...form.getInputProps(`${path}.value`)}
                                                  />
                                                ) : source?.type === "date" ? (
                                                  <DateInput
                                                    label={t`Значение условия`}
                                                    locale={i18n.locale}
                                                    value={
                                                      typeof rule.value === "string"
                                                        ? rule.value || null
                                                        : null
                                                    }
                                                    onChange={(value) =>
                                                      form.setFieldValue(
                                                        `${path}.value`,
                                                        value ?? "",
                                                      )
                                                    }
                                                  />
                                                ) : (
                                                  <TextInput
                                                    label={t`Значение условия`}
                                                    {...form.getInputProps(`${path}.value`)}
                                                  />
                                                )}
                                                <Button
                                                  variant="default"
                                                  disabled={field.visibleWhen!.rules.length === 1}
                                                  onClick={() =>
                                                    form.removeListItem(
                                                      `fields.${index}.visibleWhen.rules`,
                                                      ruleIndex,
                                                    )
                                                  }
                                                >{t`Удалить условие`}</Button>
                                              </Stack>
                                            </Paper>
                                          );
                                        })}
                                        <Button
                                          variant="default"
                                          disabled={field.visibleWhen.rules.length >= 10}
                                          onClick={() =>
                                            form.insertListItem(
                                              `fields.${index}.visibleWhen.rules`,
                                              { fieldId: "", operator: "equals", value: "" },
                                            )
                                          }
                                        >{t`Добавить условие`}</Button>
                                      </Stack>
                                    </Fieldset>
                                  )}
                                  {field.type === "text" && (
                                    <NumberInput
                                      label={t`Максимум символов`}
                                      min={1}
                                      max={10000}
                                      allowDecimal={false}
                                      {...form.getInputProps(`fields.${index}.maxLength`)}
                                    />
                                  )}
                                  {field.type === "number" && (
                                    <>
                                      <NumberInput
                                        label={t`Минимальное значение`}
                                        {...form.getInputProps(`fields.${index}.minimum`)}
                                        value={field.minimum ?? ""}
                                        onChange={(value) =>
                                          form.setFieldValue(
                                            `fields.${index}.minimum`,
                                            value === "" ? null : value,
                                          )
                                        }
                                      />
                                      <NumberInput
                                        label={t`Максимальное значение`}
                                        {...form.getInputProps(`fields.${index}.maximum`)}
                                        value={field.maximum ?? ""}
                                        onChange={(value) =>
                                          form.setFieldValue(
                                            `fields.${index}.maximum`,
                                            value === "" ? null : value,
                                          )
                                        }
                                      />
                                      <TextInput
                                        label={t`Единица измерения`}
                                        maxLength={50}
                                        {...form.getInputProps(`fields.${index}.unit`)}
                                      />
                                    </>
                                  )}
                                  {field.type === "date" && (
                                    <>
                                      <DateInput
                                        label={t`Самая ранняя дата`}
                                        locale={i18n.locale}
                                        clearable
                                        value={field.minDate || null}
                                        onChange={(value) =>
                                          form.setFieldValue(`fields.${index}.minDate`, value ?? "")
                                        }
                                      />
                                      <DateInput
                                        label={t`Самая поздняя дата`}
                                        locale={i18n.locale}
                                        clearable
                                        value={field.maxDate || null}
                                        onChange={(value) =>
                                          form.setFieldValue(`fields.${index}.maxDate`, value ?? "")
                                        }
                                      />
                                    </>
                                  )}
                                  {(field.type === "choice" || field.type === "multiChoice") && (
                                    <>
                                      {field.choices.map((choice, choiceIndex) => (
                                        <Group key={choiceIndex}>
                                          <TextInput
                                            label={t`Код варианта`}
                                            required
                                            maxLength={50}
                                            {...form.getInputProps(
                                              `fields.${index}.choices.${choiceIndex}.value`,
                                            )}
                                          />
                                          <TextInput
                                            label={t`Текст варианта`}
                                            required
                                            maxLength={200}
                                            {...form.getInputProps(
                                              `fields.${index}.choices.${choiceIndex}.label`,
                                            )}
                                          />
                                          <Button
                                            variant="default"
                                            disabled={field.choices.length === 1}
                                            onClick={() =>
                                              form.removeListItem(
                                                `fields.${index}.choices`,
                                                choiceIndex,
                                              )
                                            }
                                          >{t`Удалить вариант`}</Button>
                                        </Group>
                                      ))}
                                      <Button
                                        variant="default"
                                        disabled={field.choices.length >= 50}
                                        onClick={() =>
                                          form.insertListItem(`fields.${index}.choices`, {
                                            value: crypto.randomUUID(),
                                            label: "",
                                          })
                                        }
                                      >{t`Добавить вариант`}</Button>
                                    </>
                                  )}
                                </Stack>
                              </Paper>
                            ))}
                            <Button
                              variant="default"
                              disabled={form.values.fields.length >= 50}
                              onClick={() => form.insertListItem("fields", newStudyField())}
                            >{t`Добавить вопрос`}</Button>

                            <Title order={3}>{t`Вычисляемые шкалы`}</Title>
                            <Alert>{t`Шкалы задаёт автор формы. Это расчёт по указанным правилам, а не автоматически подтверждённый медицинский инструмент. Скрытые или пропущенные исходные ответы не заменяются нулями.`}</Alert>
                            {form.values.scores.map((score, scoreIndex) => (
                              <Paper withBorder p="md" key={score.id}>
                                <Stack>
                                  <TextInput
                                    label={t`Название шкалы`}
                                    required
                                    {...form.getInputProps(`scores.${scoreIndex}.label`)}
                                  />
                                  <Textarea
                                    label={t`Метод, назначение и ограничения шкалы`}
                                    {...form.getInputProps(`scores.${scoreIndex}.description`)}
                                  />
                                  <TextInput
                                    label={t`Единица результата`}
                                    {...form.getInputProps(`scores.${scoreIndex}.unit`)}
                                  />
                                  <NativeSelect
                                    label={t`Расчёт`}
                                    data={[
                                      { value: "sum", label: t`Сумма взвешенных значений` },
                                      { value: "mean", label: t`Среднее взвешенных значений` },
                                    ]}
                                    {...form.getInputProps(`scores.${scoreIndex}.method`)}
                                  />
                                  <Text>{t`Среднее: сумма произведений на коэффициенты, делённая на число вопросов. Все исходные вопросы должны быть видимы и заполнены.`}</Text>
                                  {score.terms.map((term, termIndex) => {
                                    const path = `scores.${scoreIndex}.terms.${termIndex}`;
                                    return (
                                      <Fieldset key={termIndex} legend={t`Слагаемое шкалы`}>
                                        <Stack>
                                          <NativeSelect
                                            label={t`Исходный вопрос`}
                                            value={term.fieldId}
                                            data={[
                                              { value: "", label: t`Выберите вопрос` },
                                              ...form.values.fields
                                                .filter((row) =>
                                                  [
                                                    "number",
                                                    "boolean",
                                                    "choice",
                                                    "multiChoice",
                                                  ].includes(row.type),
                                                )
                                                .map((row) => ({
                                                  value: row.id,
                                                  label: row.label || t`Вопрос`,
                                                })),
                                            ]}
                                            onChange={(event) => {
                                              const source = form.values.fields.find(
                                                (row) => row.id === event.currentTarget.value,
                                              );
                                              const choices =
                                                source?.type === "boolean"
                                                  ? [false, true]
                                                  : (source?.choices.map((row) => row.value) ?? []);
                                              form.replaceListItem(
                                                `scores.${scoreIndex}.terms`,
                                                termIndex,
                                                {
                                                  fieldId: event.currentTarget.value,
                                                  weight: 1,
                                                  ...(source?.type !== "number"
                                                    ? {
                                                        mapping: choices.map((value) => ({
                                                          value,
                                                          score: 0,
                                                        })),
                                                      }
                                                    : {}),
                                                },
                                              );
                                            }}
                                          />
                                          <NumberInput
                                            label={t`Коэффициент`}
                                            {...form.getInputProps(`${path}.weight`)}
                                          />
                                          {term.mapping?.map((item, itemIndex) => {
                                            const source = form.values.fields.find(
                                              (row) => row.id === term.fieldId,
                                            );
                                            const label =
                                              typeof item.value === "boolean"
                                                ? item.value
                                                  ? t`Да`
                                                  : t`Нет`
                                                : (source?.choices.find(
                                                    (row) => row.value === item.value,
                                                  )?.label ?? String(item.value));
                                            return (
                                              <NumberInput
                                                key={String(item.value)}
                                                label={`${t`Баллы`}: ${label}`}
                                                {...form.getInputProps(
                                                  `${path}.mapping.${itemIndex}.score`,
                                                )}
                                              />
                                            );
                                          })}
                                          <Button
                                            variant="default"
                                            onClick={() =>
                                              form.removeListItem(
                                                `scores.${scoreIndex}.terms`,
                                                termIndex,
                                              )
                                            }
                                          >{t`Удалить слагаемое`}</Button>
                                        </Stack>
                                      </Fieldset>
                                    );
                                  })}
                                  <Button
                                    variant="default"
                                    disabled={score.terms.length >= 50}
                                    onClick={() =>
                                      form.insertListItem(`scores.${scoreIndex}.terms`, {
                                        fieldId: "",
                                        weight: 1,
                                      })
                                    }
                                  >{t`Добавить слагаемое`}</Button>
                                  <Button
                                    color="red"
                                    variant="light"
                                    onClick={() => form.removeListItem("scores", scoreIndex)}
                                  >{t`Удалить шкалу`}</Button>
                                </Stack>
                              </Paper>
                            ))}
                            <Button
                              variant="default"
                              disabled={form.values.scores.length >= 20}
                              onClick={() =>
                                form.insertListItem("scores", {
                                  id: crypto.randomUUID(),
                                  label: "",
                                  description: "",
                                  unit: "",
                                  method: "sum",
                                  terms: [{ fieldId: "", weight: 1 }],
                                })
                              }
                            >{t`Добавить шкалу`}</Button>
                            {form.values.failureId && (
                              <Alert>{t`Открыт отклонённый черновик. Сохранение создаст новую версию после текущей; чужие изменения не перезаписываются.`}</Alert>
                            )}
                            <Group>
                              <Button
                                type="submit"
                                loading={saveForm.isPending}
                              >{t`Сохранить новую версию на устройстве`}</Button>
                              <Button
                                variant="default"
                                onClick={() => {
                                  if (form.isDirty())
                                    modals.openConfirmModal({
                                      title: t`Закрыть несохранённый шаблон?`,
                                      children: (
                                        <Text>{t`Несохранённые вопросы будут заменены; опубликованные версии останутся доступными.`}</Text>
                                      ),
                                      labels: { confirm: t`Закрыть`, cancel: t`Отмена` },
                                      onConfirm: editor.close,
                                    });
                                  else editor.close();
                                }}
                              >{t`Отмена`}</Button>
                            </Group>
                          </Stack>
                        </Fieldset>
                      </form>
                    </Paper>
                  )}
                {saveForm.isSuccess && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
                {localForms.isReady && latest.length === 0 && (
                  <Text>{t`У исследования пока нет форм.`}</Text>
                )}
                {latest.map((record) => (
                  <Paper withBorder p="md" key={record.formClientId}>
                    <Stack>
                      <Title order={2}>{record.definition.title}</Title>
                      <Badge>
                        {record.confirmed
                          ? t`Версия получена с сервера`
                          : t`Версию нужно синхронизировать перед заполнением`}
                      </Badge>
                      <Text>{record.definition.description}</Text>
                      <Group>
                        <Badge>
                          {t`Версия:`} {record.version}
                        </Badge>
                        <Badge>
                          {record.status === "published"
                            ? t`Доступна для новых ответов`
                            : t`Закрыта для новых ответов`}
                        </Badge>
                      </Group>
                      <Button
                        variant="default"
                        disabled={!canEdit || saveForm.isPending}
                        onClick={() => {
                          if (editing && form.isDirty())
                            modals.openConfirmModal({
                              title: t`Заменить несохранённый шаблон?`,
                              children: (
                                <Text>{t`Несохранённые вопросы будут заменены; опубликованные версии останутся доступными.`}</Text>
                              ),
                              labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                              onConfirm: () => newVersion(record),
                            });
                          else newVersion(record);
                        }}
                      >{t`Создать следующую версию`}</Button>
                      <Accordion>
                        <Accordion.Item value="history">
                          <Accordion.Control>{t`Версии шаблона`}</Accordion.Control>
                          <Accordion.Panel>
                            <Stack>
                              {history
                                .filter((version) => version.formClientId === record.formClientId)
                                .map((version) => (
                                  <Paper withBorder p="md" key={version.clientId}>
                                    <Stack>
                                      <Text>
                                        {t`Версия:`} {version.version}
                                      </Text>
                                      <Text>
                                        {i18n.date(new Date(version.createdAt), {
                                          dateStyle: "medium",
                                          timeStyle: "short",
                                        })}
                                      </Text>
                                      <Title order={3}>{version.definition.title}</Title>
                                      {version.definition.fields.map((field) => (
                                        <Stack key={field.id}>
                                          <Text>
                                            {field.label} — {types[field.type]}{" "}
                                            {field.required ? t`Обязательный ответ` : ""}
                                          </Text>
                                          <Text>{field.help}</Text>
                                          {field.visibleWhen && (
                                            <Stack>
                                              <Text>
                                                {t`Условия видимости`}:{" "}
                                                {field.visibleWhen.mode === "all"
                                                  ? t`Все условия`
                                                  : t`Хотя бы одно условие`}
                                              </Text>
                                              {field.visibleWhen.rules.map((rule, index) => (
                                                <Text key={index}>
                                                  {
                                                    version.definition.fields.find(
                                                      (row) => row.id === rule.fieldId,
                                                    )?.label
                                                  }{" "}
                                                  {operators[rule.operator]} {String(rule.value)}
                                                </Text>
                                              ))}
                                            </Stack>
                                          )}
                                          {field.type === "text" && (
                                            <Text>
                                              {t`Максимум символов`}: {field.maxLength}
                                            </Text>
                                          )}
                                          {field.type === "number" && (
                                            <Text>
                                              {t`Минимальное значение`}:{" "}
                                              {field.minimum === null
                                                ? "—"
                                                : i18n.number(field.minimum)}
                                              ; {t`Максимальное значение`}:{" "}
                                              {field.maximum === null
                                                ? "—"
                                                : i18n.number(field.maximum)}{" "}
                                              {field.unit}
                                            </Text>
                                          )}
                                          {field.type === "date" && (
                                            <Text>
                                              {t`Самая ранняя дата`}: {field.minDate || "—"};{" "}
                                              {t`Самая поздняя дата`}: {field.maxDate || "—"}
                                            </Text>
                                          )}
                                          {(field.type === "choice" ||
                                            field.type === "multiChoice") &&
                                            field.choices.map((choice) => (
                                              <Text key={choice.value}>
                                                {choice.value}: {choice.label}
                                              </Text>
                                            ))}
                                        </Stack>
                                      ))}{" "}
                                      {(version.definition.scores ?? []).map((score) => (
                                        <Paper withBorder p="sm" key={score.id}>
                                          <Stack>
                                            <Text fw={600}>
                                              {score.label} ({score.unit})
                                            </Text>
                                            <Text>{score.description}</Text>
                                            <Text>
                                              {score.method === "sum"
                                                ? t`Сумма взвешенных значений`
                                                : t`Среднее взвешенных значений`}
                                            </Text>
                                            {score.terms.map((term) => (
                                              <Stack key={term.fieldId}>
                                                <Text>
                                                  {
                                                    version.definition.fields.find(
                                                      (row) => row.id === term.fieldId,
                                                    )?.label
                                                  }
                                                  : × {i18n.number(term.weight)}
                                                </Text>
                                                {term.mapping?.map((item) => (
                                                  <Text key={String(item.value)}>
                                                    {String(item.value)}: {i18n.number(item.score)}
                                                  </Text>
                                                ))}
                                              </Stack>
                                            ))}
                                          </Stack>
                                        </Paper>
                                      ))}
                                    </Stack>
                                  </Paper>
                                ))}
                            </Stack>
                          </Accordion.Panel>
                        </Accordion.Item>
                      </Accordion>
                    </Stack>
                  </Paper>
                ))}
                {failures.data?.map((failure) => (
                  <Alert key={failure.id} color="yellow">
                    <Stack>
                      <Text>{t`Сервер отклонил версию формы. Черновик сохранён отдельно.`}</Text>
                      <Text>{failure.code}</Text>
                      <Button
                        variant="default"
                        disabled={!canEdit || saveForm.isPending}
                        onClick={() => {
                          if (editing && form.isDirty())
                            modals.openConfirmModal({
                              title: t`Заменить несохранённый шаблон?`,
                              children: (
                                <Text>{t`Несохранённые вопросы будут заменены; опубликованные версии останутся доступными.`}</Text>
                              ),
                              labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                              onConfirm: () => restore.mutate(failure),
                            });
                          else restore.mutate(failure);
                        }}
                      >{t`Открыть сохранённый черновик`}</Button>
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
