import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
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
import "dayjs/locale/ru";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { useClinicalRecords } from "@/src/lib/use-clinical-records";

export const Route = createFileRoute("/m_/patients_/$id")({ component: Patient });
function Patient() {
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
    editing,
    editor,
    patientForm,
    save,
    remove,
    lock,
    resume,
    downloaded,
    status,
    localClinical,
    clinical,
    clinicalEditing,
    clinicalEditor,
    clinicalForm,
    saveClinical,
    deleteClinical,
    restoreClinical,
    clinicalFailures,
    createClinical,
    editClinical,
  } = useClinicalRecords(id);
  const clinicalKinds = {
    studyIssue: t`Безопасность исследования`,
    studyVisit: t`Визит исследования`,
    enrollment: t`Участие в исследовании`,
    questionnaire: t`Опросник`,
    visit: t`Визит`,
    history: t`Анамнез`,
    allergy: t`Аллергии`,
    medication: t`Лекарственная терапия`,
    observation: t`Обследования и показатели`,
  };
  const patient = rows.find((row) => row.clientId === id);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/m/patients">{t`Все пациенты`}</Anchor>
        <Title>{t`Карта пациента`}</Title>
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
                <Text>{t`Рабочее пространство защищено парольной фразой. Она не отправляется на сервер. Сохраните её: без неё локальные данные и неотправленные изменения восстановить нельзя.`}</Text>
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
                  disabled={options.length === 0}
                  loading={unlock.isPending}
                >{t`Открыть рабочее пространство`}</Button>
                {options.length === 0 && (
                  <Text>{t`Нет подтверждённой организации или подготовленного офлайн-пространства.`}</Text>
                )}
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError || lock.isError || resume.isError || save.isError || remove.isError) && (
          <Alert color="red">{t`Не удалось сохранить изменение. Проверьте права и текущую версию записи. Ваш ввод остаётся в форме.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
              <Button
                variant="default"
                disabled={!online}
                onClick={() => resume.mutate()}
                loading={resume.isPending}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {!downloaded.isReady && <Text>{t`Загрузка локальных данных…`}</Text>}
            {downloaded.isReady && !patient && (
              <Alert>{t`Запись недоступна, удалена или ещё не сохранена на устройстве.`}</Alert>
            )}
            {patient && (
              <>
                <Title order={2}>
                  {opened.role === "doctor" ? patient.fullName : t`Исследовательская запись`}
                </Title>
                <Badge>{opened.role === "doctor" ? t`Врач` : t`Только чтение`}</Badge>
                <Text>
                  {t`Версия:`} {patient.revision}
                </Text>
                {opened.role === "doctor" && (
                  <Text>
                    {t`Дата рождения:`} {patient.birthDate}
                  </Text>
                )}
                <Title order={3}>{t`Пол`}</Title>
                <Text>
                  {opened.role === "researcher" && !patient.consentScope.includes("sex")
                    ? t`Не разрешено согласием`
                    : { female: t`Женский`, male: t`Мужской`, unknown: t`Не указан` }[patient.sex]}
                </Text>
                <Title order={3}>{t`Диагнозы`}</Title>
                <Text>
                  {opened.role === "researcher" && !patient.consentScope.includes("diagnoses")
                    ? t`Не разрешено согласием`
                    : patient.diagnosisCodes.join(", ") || t`Не указаны`}
                </Text>
                {opened.role === "doctor" && (
                  <>
                    <Title order={3}>{t`Клинические заметки`}</Title>
                    <Text>{patient.notes || t`Не указаны`}</Text>
                  </>
                )}
                <Text>
                  {t`Обновлено:`}{" "}
                  {i18n.date(new Date(patient.updatedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
                <Anchor
                  renderRoot={(props) => (
                    <Link {...props} to="/m/patients/$id/consents" params={{ id }} />
                  )}
                >{t`Согласия пациента`}</Anchor>
                {opened.role === "doctor" && (
                  <Anchor
                    renderRoot={(props) => (
                      <Link {...props} to="/m/patients/$id/history" params={{ id }} />
                    )}
                  >{t`История клинических записей`}</Anchor>
                )}

                {opened.role === "doctor" && (
                  <Group>
                    <Button
                      disabled={!workspace.canWrite()}
                      onClick={() => {
                        patientForm.setValues({
                          ...patient,
                          expectedRevision: patient.revision,
                          diagnosisCodes: patient.diagnosisCodes.join(", "),
                          failureId: "",
                        });
                        editor.open();
                      }}
                    >{t`Редактировать карту`}</Button>
                    <Button
                      color="red"
                      variant="light"
                      disabled={!workspace.canWrite()}
                      onClick={() =>
                        modals.openConfirmModal({
                          title: t`Удалить запись пациента?`,
                          children: (
                            <Text>{t`Запись будет удалена после синхронизации. Неотправленные изменения сохраняются на устройстве.`}</Text>
                          ),
                          labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                          onConfirm: () =>
                            remove.mutate({ clientId: id, expectedRevision: patient.revision }),
                        })
                      }
                    >{t`Удалить запись`}</Button>
                  </Group>
                )}
                {editing && opened.role === "doctor" && patientForm.values.clientId === id && (
                  <Paper withBorder p="md">
                    <form onSubmit={patientForm.onSubmit((values) => save.mutate(values))}>
                      <Stack>
                        <TextInput
                          label={t`ФИО`}
                          required
                          maxLength={200}
                          {...patientForm.getInputProps("fullName")}
                        />
                        <TextInput
                          type="date"
                          label={t`Дата рождения`}
                          required
                          {...patientForm.getInputProps("birthDate")}
                        />
                        <NativeSelect
                          label={t`Пол`}
                          data={[
                            { value: "unknown", label: t`Не указан` },
                            { value: "female", label: t`Женский` },
                            { value: "male", label: t`Мужской` },
                          ]}
                          {...patientForm.getInputProps("sex")}
                        />
                        <TextInput
                          label={t`Коды МКБ через запятую`}
                          {...patientForm.getInputProps("diagnosisCodes")}
                        />
                        <Textarea
                          label={t`Клинические заметки`}
                          maxLength={20000}
                          {...patientForm.getInputProps("notes")}
                        />
                        <Group>
                          <Button
                            type="submit"
                            disabled={!workspace.canWrite()}
                            loading={save.isPending}
                          >{t`Сохранить на устройстве`}</Button>
                          <Button
                            variant="default"
                            onClick={() => {
                              patientForm.reset();
                              editor.close();
                            }}
                          >{t`Отмена`}</Button>
                        </Group>
                      </Stack>
                    </form>
                  </Paper>
                )}
                {opened.role === "doctor" && (
                  <>
                    <Anchor
                      renderRoot={(props) => (
                        <Link {...props} to="/m/patients/$id/visits" params={{ id }} />
                      )}
                    >{t`Визиты пациента`}</Anchor>
                    <Anchor
                      renderRoot={(props) => (
                        <Link {...props} to="/m/patients/$id/enrollment" params={{ id }} />
                      )}
                    >{t`Участие в исследованиях`}</Anchor>
                    <Anchor
                      renderRoot={(props) => (
                        <Link {...props} to="/m/patients/$id/forms" params={{ id }} />
                      )}
                    >{t`Опросники пациента`}</Anchor>
                    <Title order={2}>{t`Клиническая история`}</Title>
                    <Button
                      disabled={!workspace.canWrite()}
                      onClick={createClinical}
                    >{t`Добавить клиническую запись`}</Button>
                    {!localClinical.isReady && (
                      <Text>{t`Клиническая история ещё не загружена. Для первой загрузки нужен интернет.`}</Text>
                    )}
                    {(saveClinical.isError ||
                      deleteClinical.isError ||
                      restoreClinical.isError) && (
                      <Alert color="red">{t`Не удалось сохранить изменение. Проверьте права и текущую версию записи. Ваш ввод остаётся в форме.`}</Alert>
                    )}
                    {clinicalEditing && clinicalForm.values.patientClientId === id && (
                      <Paper withBorder p="md">
                        <form
                          onSubmit={clinicalForm.onSubmit((input) => saveClinical.mutate(input))}
                        >
                          <Fieldset disabled={saveClinical.isPending}>
                            <Stack>
                              <NativeSelect
                                label={t`Раздел карты`}
                                disabled={Boolean(clinicalForm.values.clientId)}
                                data={Object.entries(clinicalKinds)
                                  .filter(
                                    ([value]) => value !== "visit" && value !== "questionnaire",
                                  )
                                  .map(([value, label]) => ({
                                    value,
                                    label,
                                  }))}
                                {...clinicalForm.getInputProps("kind")}
                              />
                              <DateInput
                                label={t`Дата события`}
                                locale={i18n.locale}
                                required
                                {...clinicalForm.getInputProps("occurredOn")}
                              />
                              {clinicalForm.values.kind === "history" && (
                                <Textarea
                                  label={t`Анамнез и клиническое событие`}
                                  required
                                  maxLength={10000}
                                  {...clinicalForm.getInputProps("text")}
                                />
                              )}
                              {clinicalForm.values.kind === "allergy" && (
                                <>
                                  <TextInput
                                    label={t`Аллерген или вещество`}
                                    required
                                    maxLength={200}
                                    {...clinicalForm.getInputProps("substance")}
                                  />
                                  <Textarea
                                    label={t`Зарегистрированная реакция`}
                                    required
                                    maxLength={1000}
                                    {...clinicalForm.getInputProps("reaction")}
                                  />
                                  <NativeSelect
                                    label={t`Тяжесть реакции`}
                                    data={[
                                      { value: "unknown", label: t`Не указана` },
                                      { value: "mild", label: t`Лёгкая` },
                                      { value: "moderate", label: t`Умеренная` },
                                      { value: "severe", label: t`Тяжёлая` },
                                    ]}
                                    {...clinicalForm.getInputProps("severity")}
                                  />
                                  <NativeSelect
                                    label={t`Статус аллергии`}
                                    data={[
                                      { value: "active", label: t`Активна` },
                                      { value: "inactive", label: t`Неактивна` },
                                    ]}
                                    {...clinicalForm.getInputProps("allergyStatus")}
                                  />
                                </>
                              )}
                              {clinicalForm.values.kind === "medication" && (
                                <>
                                  <TextInput
                                    label={t`Препарат`}
                                    required
                                    maxLength={200}
                                    {...clinicalForm.getInputProps("drug")}
                                  />
                                  <TextInput
                                    label={t`Код препарата`}
                                    maxLength={100}
                                    {...clinicalForm.getInputProps("code")}
                                  />
                                  <TextInput
                                    label={t`Зарегистрированная дозировка`}
                                    required
                                    maxLength={200}
                                    {...clinicalForm.getInputProps("dosage")}
                                  />
                                  <TextInput
                                    label={t`Способ применения`}
                                    maxLength={100}
                                    {...clinicalForm.getInputProps("route")}
                                  />
                                  <DateInput
                                    label={t`Дата окончания приёма`}
                                    locale={i18n.locale}
                                    clearable
                                    {...clinicalForm.getInputProps("endedOn")}
                                  />
                                  <NativeSelect
                                    label={t`Статус терапии`}
                                    data={[
                                      { value: "active", label: t`Продолжается` },
                                      { value: "completed", label: t`Завершена` },
                                      { value: "stopped", label: t`Прекращена` },
                                    ]}
                                    {...clinicalForm.getInputProps("medicationStatus")}
                                  />
                                </>
                              )}
                              {clinicalForm.values.kind === "observation" && (
                                <>
                                  <TextInput
                                    label={t`Показатель или обследование`}
                                    required
                                    maxLength={200}
                                    {...clinicalForm.getInputProps("name")}
                                  />
                                  <TextInput
                                    label={t`Код исследования`}
                                    maxLength={100}
                                    {...clinicalForm.getInputProps("code")}
                                  />
                                  <NativeSelect
                                    label={t`Тип результата`}
                                    data={[
                                      { value: "numeric", label: t`Числовой` },
                                      { value: "text", label: t`Текстовый` },
                                    ]}
                                    {...clinicalForm.getInputProps("resultType")}
                                  />
                                  {clinicalForm.values.resultType === "numeric" ? (
                                    <NumberInput
                                      label={t`Числовой результат`}
                                      required
                                      {...clinicalForm.getInputProps("numericValue")}
                                    />
                                  ) : (
                                    <TextInput
                                      label={t`Текстовый результат`}
                                      required
                                      maxLength={1000}
                                      {...clinicalForm.getInputProps("textValue")}
                                    />
                                  )}
                                  <TextInput
                                    label={t`Единица измерения`}
                                    maxLength={100}
                                    {...clinicalForm.getInputProps("unit")}
                                  />
                                </>
                              )}
                              <Textarea
                                label={t`Примечание к записи`}
                                maxLength={2000}
                                {...clinicalForm.getInputProps("notes")}
                              />
                              {clinicalForm.values.failureId && !clinicalForm.values.clientId && (
                                <Alert>{t`Черновик будет сохранён как новая клиническая запись. Удалённая версия не восстанавливается автоматически.`}</Alert>
                              )}
                              <Group>
                                <Button
                                  type="submit"
                                  disabled={!workspace.canWrite()}
                                  loading={saveClinical.isPending}
                                >{t`Сохранить на устройстве`}</Button>
                                <Button
                                  variant="default"
                                  onClick={() => {
                                    clinicalForm.reset();
                                    clinicalEditor.close();
                                  }}
                                >{t`Отмена`}</Button>
                              </Group>
                            </Stack>
                          </Fieldset>
                        </form>
                      </Paper>
                    )}
                    {(saveClinical.isSuccess || deleteClinical.isSuccess) && (
                      <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                    )}
                    {localClinical.isReady && clinical.length === 0 && (
                      <Text>{t`Клинических записей пока нет.`}</Text>
                    )}
                    {clinical.map(
                      (record) =>
                        record.payload && (
                          <Paper withBorder p="md" key={record.clientId}>
                            <Stack>
                              <Group>
                                <Badge>{clinicalKinds[record.payload.kind]}</Badge>
                                <Text>
                                  {i18n.date(new Date(`${record.payload.occurredOn}T12:00:00`), {
                                    dateStyle: "medium",
                                  })}
                                </Text>
                                <Text>
                                  {t`Версия:`} {record.revision}
                                </Text>
                              </Group>
                              {record.payload.kind === "history" && (
                                <Text>{record.payload.text}</Text>
                              )}
                              {record.payload.kind === "allergy" && (
                                <>
                                  <Title order={3}>{record.payload.substance}</Title>
                                  <Text>{record.payload.reaction}</Text>
                                  <Group>
                                    <Badge>
                                      {
                                        {
                                          unknown: t`Тяжесть не указана`,
                                          mild: t`Лёгкая`,
                                          moderate: t`Умеренная`,
                                          severe: t`Тяжёлая`,
                                        }[record.payload.severity]
                                      }
                                    </Badge>
                                    <Badge>
                                      {record.payload.status === "active"
                                        ? t`Активна`
                                        : t`Неактивна`}
                                    </Badge>
                                  </Group>
                                </>
                              )}
                              {record.payload.kind === "medication" && (
                                <>
                                  <Title order={3}>{record.payload.drug}</Title>
                                  <Text>{record.payload.code}</Text>
                                  <Text>{record.payload.dosage}</Text>
                                  <Text>{record.payload.route}</Text>
                                  <Badge>
                                    {
                                      {
                                        active: t`Продолжается`,
                                        completed: t`Завершена`,
                                        stopped: t`Прекращена`,
                                      }[record.payload.status]
                                    }
                                  </Badge>
                                  {record.payload.endedOn && (
                                    <Text>
                                      {t`Дата окончания приёма:`} {record.payload.endedOn}
                                    </Text>
                                  )}
                                </>
                              )}
                              {record.payload.kind === "observation" && (
                                <>
                                  <Title order={3}>{record.payload.name}</Title>
                                  <Text>{record.payload.code}</Text>
                                  <Text>
                                    {record.payload.numericValue === null
                                      ? record.payload.textValue
                                      : i18n.number(record.payload.numericValue)}{" "}
                                    {record.payload.unit}
                                  </Text>
                                </>
                              )}
                              <Text>{record.payload.notes}</Text>
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
                                  disabled={!workspace.canWrite()}
                                  onClick={() => editClinical(record)}
                                >{t`Изменить запись`}</Button>
                                <Button
                                  color="red"
                                  variant="light"
                                  disabled={!workspace.canWrite() || deleteClinical.isPending}
                                  onClick={() =>
                                    modals.openConfirmModal({
                                      title: t`Удалить клиническую запись?`,
                                      children: (
                                        <Text>{t`Содержимое будет очищено после синхронизации. В истории останется запись о действии.`}</Text>
                                      ),
                                      labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                      onConfirm: () => deleteClinical.mutate(record),
                                    })
                                  }
                                >{t`Удалить запись`}</Button>
                              </Group>
                            </Stack>
                          </Paper>
                        ),
                    )}
                    {clinicalFailures.data?.map((failure) => (
                      <Alert color="yellow" key={failure.id}>
                        <Stack>
                          <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                          <Text>{failure.code}</Text>
                          {failure.action !== "delete" ? (
                            <Button
                              variant="default"
                              onClick={() => restoreClinical.mutate(failure)}
                            >{t`Открыть сохранённый черновик`}</Button>
                          ) : (
                            <Text>{t`Удаление отклонено. Сравните текущую запись перед повторным удалением.`}</Text>
                          )}
                        </Stack>
                      </Alert>
                    ))}
                  </>
                )}
                {save.isSuccess && (
                  <Alert color="green">{t`Изменения сохранены локально. Статус отправки отображается в очереди.`}</Alert>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
