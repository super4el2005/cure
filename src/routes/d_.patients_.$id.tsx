import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

export const Route = createFileRoute("/d_/patients_/$id")({ component: Patient });
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
  } = usePatientWorkspace();
  const patient = rows.find((row) => row.clientId === id);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/d/patients">{t`Все пациенты`}</Anchor>
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
                    <Link {...props} to="/d/patients/$id/consents" params={{ id }} />
                  )}
                >{t`Согласия пациента`}</Anchor>
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
