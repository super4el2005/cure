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
