import { useLingui } from "@lingui/react/macro";
import {
  Modal,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Fieldset,
  Group,
  MultiSelect,
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";
import "dayjs/locale/ru";

import { useQuestionnaires } from "@/src/lib/use-questionnaires";

export const Route = createFileRoute("/m_/patients_/$id_/forms")({ component: Questionnaires });
function Questionnaires() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    blocker,
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
    localTemplates,
    localProjects,
    availableTemplates,
    pendingTemplatesCount,
    localResponses,
    responses,
    editing,
    editor,
    form,
    selectTemplate,
    saveResponse,
    removeResponse,
    failures,
    restore,
    newResponse,
    editResponse,
    canEditResponse,
  } = useQuestionnaires(id);
  const patient = rows.find((row) => row.clientId === id);
  const templateOptions = availableTemplates.map((version) => ({
    value: version.clientId,
    label: `${projectMap.get(version.projectClientId)?.title ?? t`Исследование`} — ${version.definition.title} (${version.version})`,
  }));
  if (
    form.values.template &&
    !templateOptions.some((option) => option.value === form.values.template!.clientId)
  )
    templateOptions.push({
      value: form.values.template.clientId,
      label: `${form.values.template.definition.title} (${t`Сохранённая версия`}: ${form.values.template.version})`,
    });
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

        <Anchor
          renderRoot={(props) => <Link {...props} to="/m/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Опросники пациента`}</Title>
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
          selectTemplate.isError ||
          saveResponse.isError ||
          removeResponse.isError ||
          restore.isError ||
          failures.isError) && (
          <Alert color="red">{t`Не удалось сохранить ответ. Проверьте права проекта, актуальность шаблона и версию записи. Введённые значения остаются в форме.`}</Alert>
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
              <Alert>{t`Согласие на пол и диагнозы не открывает ответы опросников исследователю.`}</Alert>
            ) : (
              <>
                {!downloaded.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
                {downloaded.isReady && !patient && (
                  <Alert>{t`Пациент не найден или недоступен в выбранной организации.`}</Alert>
                )}
                {patient && (
                  <>
                    <Title order={2}>{patient.fullName}</Title>
                    {!projects && (
                      <Alert>
                        <Text>{t`Для заполнения откройте исследовательское пространство той же организации, затем вернитесь к пациенту. Ранее сохранённые ответы доступны для чтения.`}</Text>
                        <Anchor component={Link} to="/m/projects">{t`Мои исследования`}</Anchor>
                      </Alert>
                    )}
                    {projects && (!localTemplates.isReady || !localProjects.isReady) && (
                      <Text>{t`Шаблоны ещё не загружены. Для первой загрузки нужен интернет.`}</Text>
                    )}
                    <Button
                      disabled={
                        !workspace.canWrite() ||
                        !projects ||
                        !localTemplates.isReady ||
                        availableTemplates.length === 0 ||
                        saveResponse.isPending ||
                        removeResponse.isPending
                      }
                      onClick={() => {
                        if (editing && form.isDirty())
                          modals.openConfirmModal({
                            title: t`Заменить несохранённый ответ?`,
                            children: (
                              <Text>{t`Введённые ответы будут заменены. Сохранённые записи останутся доступными.`}</Text>
                            ),
                            labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                            onConfirm: newResponse,
                          });
                        else newResponse();
                      }}
                    >{t`Заполнить опросник`}</Button>
                    {pendingTemplatesCount > 0 && (
                      <Alert>{t`Новые версии шаблонов ещё не отправлены. Сначала синхронизируйте исследовательское пространство; затем их можно будет заполнять без сети.`}</Alert>
                    )}
                    {projects && localTemplates.isReady && availableTemplates.length === 0 && (
                      <Text>{t`Нет доступных опубликованных форм. Владелец или координатор может добавить шаблон в исследовании.`}</Text>
                    )}
                    {editing &&
                      form.values.scope === workspace.scope &&
                      form.values.patientClientId === id && (
                        <Paper withBorder p="md">
                          <form onSubmit={form.onSubmit((values) => saveResponse.mutate(values))}>
                            <Fieldset disabled={saveResponse.isPending}>
                              <Stack>
                                <Select
                                  label={t`Шаблон опросника`}
                                  searchable
                                  allowDeselect={false}
                                  data={templateOptions}
                                  value={form.values.template?.clientId ?? null}
                                  disabled={
                                    Boolean(form.values.clientId) || selectTemplate.isPending
                                  }
                                  error={form.errors.template}
                                  onChange={(value) => {
                                    if (!value) return;
                                    if (form.isDirty() && form.values.template)
                                      modals.openConfirmModal({
                                        title: t`Заменить несохранённый ответ?`,
                                        children: (
                                          <Text>{t`Введённые ответы будут заменены. Сохранённые записи останутся доступными.`}</Text>
                                        ),
                                        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                        onConfirm: () => selectTemplate.mutate(value),
                                      });
                                    else selectTemplate.mutate(value);
                                  }}
                                />
                                {form.values.template && (
                                  <>
                                    <Title order={3}>{form.values.template.definition.title}</Title>
                                    <Text>{form.values.template.definition.description}</Text>
                                    <Text>
                                      {t`Версия шаблона:`} {form.values.template.version}
                                    </Text>
                                    <DateInput
                                      label={t`Дата заполнения`}
                                      required
                                      locale={i18n.locale}
                                      {...form.getInputProps("occurredOn")}
                                    />
                                    <NativeSelect
                                      label={t`Статус ответа`}
                                      data={[
                                        ...(form.values.originalStatus === "final"
                                          ? []
                                          : [{ value: "draft", label: t`Черновик` }]),
                                        { value: "final", label: t`Окончательный ответ` },
                                      ]}
                                      {...form.getInputProps("status")}
                                    />
                                    <Text>{t`Черновик может быть неполным. Для окончательного ответа заполните все обязательные вопросы.`}</Text>
                                    {Object.keys(form.errors).length > 0 && (
                                      <Alert color="red">{t`Проверьте ответы и обязательные поля. Значения должны соответствовать типам и границам шаблона.`}</Alert>
                                    )}
                                    {form.values.template.definition.fields.map((field) => (
                                      <Paper withBorder p="md" key={field.id}>
                                        <Stack>
                                          {field.type === "text" && (
                                            <Textarea
                                              label={field.label}
                                              description={field.help}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              maxLength={field.maxLength}
                                              {...form.getInputProps(`answers.${field.id}`)}
                                            />
                                          )}
                                          {field.type === "number" && (
                                            <NumberInput
                                              clampBehavior="none"
                                              label={field.label}
                                              description={`${field.help} ${field.unit}`}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              min={field.minimum ?? undefined}
                                              max={field.maximum ?? undefined}
                                              {...form.getInputProps(`answers.${field.id}`)}
                                            />
                                          )}
                                          {field.type === "date" && (
                                            <DateInput
                                              label={field.label}
                                              description={field.help}
                                              locale={i18n.locale}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              {...(field.minDate ? { minDate: field.minDate } : {})}
                                              {...(field.maxDate ? { maxDate: field.maxDate } : {})}
                                              {...form.getInputProps(`answers.${field.id}`)}
                                              value={
                                                typeof form.values.answers[field.id] === "string" &&
                                                form.values.answers[field.id]
                                                  ? (form.values.answers[field.id] as string)
                                                  : null
                                              }
                                              onChange={(value) =>
                                                form.setFieldValue(
                                                  `answers.${field.id}`,
                                                  value ?? "",
                                                )
                                              }
                                            />
                                          )}
                                          {field.type === "boolean" && (
                                            <NativeSelect
                                              label={field.label}
                                              description={field.help}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              data={[
                                                { value: "", label: t`Ответ не указан` },
                                                { value: "true", label: t`Да` },
                                                { value: "false", label: t`Нет` },
                                              ]}
                                              {...form.getInputProps(`answers.${field.id}`)}
                                            />
                                          )}
                                          {field.type === "choice" && (
                                            <NativeSelect
                                              label={field.label}
                                              description={field.help}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              data={[
                                                { value: "", label: t`Ответ не указан` },
                                                ...field.choices,
                                              ]}
                                              {...form.getInputProps(`answers.${field.id}`)}
                                            />
                                          )}
                                          {field.type === "multiChoice" && (
                                            <MultiSelect
                                              label={field.label}
                                              description={field.help}
                                              required={
                                                form.values.status === "final" && field.required
                                              }
                                              data={field.choices}
                                              searchable
                                              clearable
                                              {...form.getInputProps(`answers.${field.id}`)}
                                            />
                                          )}
                                        </Stack>
                                      </Paper>
                                    ))}
                                    <Textarea
                                      label={t`Примечание к записи`}
                                      maxLength={2000}
                                      {...form.getInputProps("notes")}
                                    />
                                    <Textarea
                                      label={t`Причина исправления окончательного ответа`}
                                      required={form.values.originalStatus === "final"}
                                      maxLength={2000}
                                      {...form.getInputProps("amendmentReason")}
                                    />
                                    {form.values.failureId && (
                                      <Alert>{t`Открыт отклонённый черновик. Перед сохранением сравните его с текущими ответами. Устаревший шаблон нужно выбрать заново; ответы не переносятся автоматически.`}</Alert>
                                    )}
                                  </>
                                )}
                                <Group>
                                  <Button
                                    type="submit"
                                    disabled={
                                      !workspace.canWrite() || !projects || !form.values.template
                                    }
                                    loading={saveResponse.isPending}
                                  >{t`Сохранить на устройстве`}</Button>
                                  <Button
                                    variant="default"
                                    onClick={() => {
                                      if (form.isDirty())
                                        modals.openConfirmModal({
                                          title: t`Закрыть несохранённый ответ?`,
                                          children: (
                                            <Text>{t`Введённые ответы будут потеряны. Сохранённые записи останутся доступными.`}</Text>
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
                    {(saveResponse.isSuccess || removeResponse.isSuccess) && (
                      <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                    )}
                    {!localResponses.isReady && (
                      <Text>{t`Ответы ещё не загружены. Для первой загрузки нужен интернет.`}</Text>
                    )}
                    {localResponses.isReady && responses.length === 0 && (
                      <Text>{t`У пациента пока нет ответов на опросники.`}</Text>
                    )}
                    {responses.map(
                      (record) =>
                        record.payload?.kind === "questionnaire" && (
                          <Paper withBorder p="md" key={record.clientId}>
                            <Stack>
                              <Title order={2}>{record.payload.definition.title}</Title>
                              <Group>
                                <Badge>
                                  {record.payload.status === "draft"
                                    ? t`Черновик`
                                    : t`Окончательный ответ`}
                                </Badge>
                                <Text>
                                  {t`Версия записи:`} {record.revision}
                                </Text>
                                <Text>
                                  {t`Версия шаблона:`} {record.payload.formVersion}
                                </Text>
                              </Group>
                              <Text>
                                {i18n.date(new Date(`${record.payload.occurredOn}T12:00:00`), {
                                  dateStyle: "medium",
                                })}
                              </Text>
                              {record.payload.definition.fields.map((field) => {
                                const answer =
                                  record.payload?.kind === "questionnaire"
                                    ? record.payload.answers[field.id]
                                    : undefined;
                                return (
                                  <Stack key={field.id}>
                                    <Text fw={600}>{field.label}</Text>
                                    <Text>
                                      {answer === undefined
                                        ? t`Ответ не указан`
                                        : typeof answer === "boolean"
                                          ? answer
                                            ? t`Да`
                                            : t`Нет`
                                          : field.type === "choice"
                                            ? (field.choices.find(
                                                (choice) => choice.value === answer,
                                              )?.label ?? String(answer))
                                            : field.type === "multiChoice" && Array.isArray(answer)
                                              ? answer
                                                  .map(
                                                    (value) =>
                                                      field.choices.find(
                                                        (choice) => choice.value === value,
                                                      )?.label ?? value,
                                                  )
                                                  .join(", ")
                                              : typeof answer === "number"
                                                ? `${i18n.number(answer)} ${field.type === "number" ? field.unit : ""}`
                                                : field.type === "date" &&
                                                    typeof answer === "string"
                                                  ? i18n.date(new Date(`${answer}T12:00:00`), {
                                                      dateStyle: "medium",
                                                    })
                                                  : String(answer)}
                                    </Text>
                                  </Stack>
                                );
                              })}
                              <Text>{record.payload.notes}</Text>
                              {record.payload.amendmentReason && (
                                <Text>
                                  {t`Причина исправления:`} {record.payload.amendmentReason}
                                </Text>
                              )}
                              <Group>
                                <Button
                                  variant="default"
                                  disabled={
                                    !workspace.canWrite() ||
                                    !canEditResponse(record.payload) ||
                                    saveResponse.isPending ||
                                    removeResponse.isPending
                                  }
                                  onClick={() => {
                                    if (editing && form.isDirty())
                                      modals.openConfirmModal({
                                        title: t`Заменить несохранённый ответ?`,
                                        children: (
                                          <Text>{t`Введённые ответы будут заменены. Сохранённые записи останутся доступными.`}</Text>
                                        ),
                                        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                        onConfirm: () => editResponse(record),
                                      });
                                    else editResponse(record);
                                  }}
                                >{t`Изменить ответ`}</Button>
                                <Button
                                  color="red"
                                  variant="light"
                                  disabled={
                                    !workspace.canWrite() ||
                                    saveResponse.isPending ||
                                    removeResponse.isPending
                                  }
                                  onClick={() =>
                                    modals.openConfirmModal({
                                      title: t`Удалить ответ опросника?`,
                                      children: (
                                        <Text>{t`Ответы будут очищены после синхронизации. В аудите останутся метаданные удаления.`}</Text>
                                      ),
                                      labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                      onConfirm: () => removeResponse.mutate(record),
                                    })
                                  }
                                >{t`Удалить`}</Button>
                              </Group>
                            </Stack>
                          </Paper>
                        ),
                    )}
                    {failures.data?.map((failure) => (
                      <Alert color="yellow" key={failure.id}>
                        <Stack>
                          <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                          <Text>{failure.code}</Text>
                          {failure.action !== "delete" ? (
                            <Button
                              variant="default"
                              disabled={saveResponse.isPending}
                              onClick={() => {
                                if (editing && form.isDirty())
                                  modals.openConfirmModal({
                                    title: t`Заменить несохранённый ответ?`,
                                    children: (
                                      <Text>{t`Введённые ответы будут заменены. Сохранённые записи останутся доступными.`}</Text>
                                    ),
                                    labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                    onConfirm: () => restore.mutate(failure),
                                  });
                                else restore.mutate(failure);
                              }}
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
