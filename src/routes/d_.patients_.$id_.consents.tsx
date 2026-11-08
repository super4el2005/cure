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
  NativeSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";
import { failureDetails } from "@/src/observability/events";

export const Route = createFileRoute("/d_/patients_/$id_/consents")({ component: Consents });
function Consents() {
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
    consenting,
    consentDialog,
    consentForm,
    consent,
    sharing,
    sharingDialog,
    shareForm,
    share,
    researchers,
    lock,
    resume,
    downloaded,
    status,
    restore,
  } = usePatientWorkspace();
  const patient = rows.find((row) => row.clientId === id);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor
          renderRoot={(props) => <Link {...props} to="/d/patients/$id" params={{ id }} />}
        >{t`Карта пациента`}</Anchor>
        <Title>{t`Согласия пациента`}</Title>
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
        {(unlock.isError || lock.isError || resume.isError || consent.isError || share.isError) && (
          <Alert color="red">{t`Не удалось сохранить изменение. Проверьте права и текущую версию записи. Ваш ввод остаётся в форме.`}</Alert>
        )}
        {share.isError && failureDetails(share.error).code === "CONSENT_REQUIRED" && (
          <Alert color="yellow">{t`Для выдачи доступа сначала зарегистрируйте согласие пациента для выбранного исследователя и дождитесь синхронизации.`}</Alert>
        )}
        {consent.isError && failureDetails(consent.error).code === "CONSENT_EXPIRED" && (
          <Alert color="yellow">{t`Срок согласия истёк. Для нового срока требуется новая версия с подтверждающим документом.`}</Alert>
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
                {opened.role === "researcher" && (
                  <Paper withBorder p="md">
                    <Stack>
                      <Badge>{t`Разрешено только чтение`}</Badge>
                      <Text>
                        {t`Доступны категории:`}{" "}
                        {patient.consentScope
                          .map((category) => (category === "sex" ? t`Пол` : t`Диагнозы`))
                          .join(", ")}
                      </Text>
                      {patient.accessExpiresAt && (
                        <Text>
                          {t`Доступ действует до:`}{" "}
                          {i18n.date(new Date(patient.accessExpiresAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </Text>
                      )}
                      <Text>{t`Документы, имена получателей и полная история согласий исследователю не передаются.`}</Text>
                    </Stack>
                  </Paper>
                )}
                {opened.role === "doctor" && (
                  <>
                    <Button
                      disabled={!workspace.canWrite()}
                      onClick={() => {
                        const latest = patient.consentHistory.at(-1);
                        consent.reset();
                        consentForm.setValues({
                          clientId: id,
                          expectedRevision: patient.revision,
                          kind: "granted",
                          purpose: latest?.purpose ?? "",
                          recipients: latest?.recipients ?? [],
                          scope: latest?.scope ?? ["sex", "diagnoses"],
                          documentReference: "",
                          days: 30,
                          attested: false,
                          failureId: "",
                          archivedExpiresAt: 0,
                        });
                        consentDialog.open();
                      }}
                    >{t`Зарегистрировать согласие или отзыв`}</Button>
                    <Button
                      variant="default"
                      disabled={!status.data?.online}
                      onClick={() => {
                        shareForm.setValues({
                          clientId: id,
                          researcherId: "",
                          days: 30,
                          active: true,
                        });
                        sharingDialog.open();
                      }}
                    >{t`Настроить доступ исследователя`}</Button>
                    {consent.isSuccess && (
                      <Alert>{t`Согласие или отзыв сохранены на устройстве. Для выдачи доступа дождитесь отправки на сервер.`}</Alert>
                    )}
                    {consenting &&
                      consentForm.values.clientId === id &&
                      opened.role === "doctor" && (
                        <Paper withBorder p="md">
                          <form onSubmit={consentForm.onSubmit((values) => consent.mutate(values))}>
                            <Stack>
                              <Title
                                order={2}
                              >{t`Согласие на исследовательское использование данных`}</Title>
                              <Text>{t`Врач фиксирует уже полученное согласие или его отзыв. Запись в системе не заменяет подпись пациента.`}</Text>
                              <NativeSelect
                                label={t`Действие`}
                                data={[
                                  {
                                    value: "granted",
                                    label: t`Зарегистрировать новую версию согласия`,
                                  },
                                  { value: "withdrawn", label: t`Зарегистрировать отзыв согласия` },
                                ]}
                                {...consentForm.getInputProps("kind")}
                              />
                              <TextInput
                                label={t`Цель использования данных`}
                                maxLength={1000}
                                {...consentForm.getInputProps("purpose")}
                              />
                              <MultiSelect
                                label={t`Получатели данных`}
                                searchable
                                data={[
                                  ...new Map([
                                    ...(researchers.data ?? []).map(
                                      (person) =>
                                        [
                                          person.userId,
                                          {
                                            value: person.userId,
                                            label: person.displayName || person.userId,
                                          },
                                        ] as const,
                                    ),
                                    ...consentForm.values.recipients
                                      .filter(
                                        (id) =>
                                          !(researchers.data ?? []).some(
                                            (person) => person.userId === id,
                                          ),
                                      )
                                      .map((id) => [id, { value: id, label: id }] as const),
                                  ]).values(),
                                ]}
                                {...consentForm.getInputProps("recipients")}
                              />
                              <MultiSelect
                                label={t`Разрешённые категории данных`}
                                data={[
                                  { value: "sex", label: t`Пол` },
                                  { value: "diagnoses", label: t`Диагнозы` },
                                ]}
                                {...consentForm.getInputProps("scope")}
                              />
                              <NumberInput
                                label={t`Срок действия в днях`}
                                min={1}
                                max={365}
                                allowDecimal={false}
                                disabled={
                                  consentForm.values.kind === "withdrawn" ||
                                  Boolean(consentForm.values.archivedExpiresAt)
                                }
                                {...consentForm.getInputProps("days")}
                              />
                              {Boolean(consentForm.values.archivedExpiresAt) && (
                                <Alert>
                                  <Stack>
                                    <Text>{t`Срок восстановленного согласия сохранён без продления.`}</Text>
                                    <Text>
                                      {new Intl.DateTimeFormat(i18n.locale, {
                                        dateStyle: "medium",
                                        timeStyle: "short",
                                      }).format(consentForm.values.archivedExpiresAt)}
                                    </Text>
                                    <Button
                                      variant="default"
                                      onClick={() =>
                                        consentForm.setValues({
                                          archivedExpiresAt: 0,
                                          documentReference: "",
                                          attested: false,
                                        })
                                      }
                                    >{t`Оформить новую версию с другим сроком`}</Button>
                                  </Stack>
                                </Alert>
                              )}
                              <TextInput
                                label={t`Ссылка или номер документа, подтверждающего согласие или отзыв`}
                                maxLength={1000}
                                {...consentForm.getInputProps("documentReference")}
                              />
                              <Checkbox
                                label={t`Подтверждаю, что согласие или отзыв получены и документированы`}
                                {...consentForm.getInputProps("attested", { type: "checkbox" })}
                              />
                              {!online && (
                                <Text>{t`Без сети доступны ранее загруженные получатели. Отзыв на сервере вступит в силу после синхронизации.`}</Text>
                              )}
                              <Group>
                                <Button
                                  type="submit"
                                  loading={consent.isPending}
                                  disabled={!status.data?.leader || !downloaded.isReady}
                                >{t`Сохранить на устройстве`}</Button>
                                <Button
                                  variant="default"
                                  onClick={consentDialog.close}
                                >{t`Отмена`}</Button>
                              </Group>
                            </Stack>
                          </form>
                        </Paper>
                      )}
                    {share.isSuccess && <Alert>{t`Права доступа обновлены на сервере.`}</Alert>}
                    {sharing && shareForm.values.clientId === id && opened.role === "doctor" && (
                      <Paper withBorder p="md">
                        <form onSubmit={shareForm.onSubmit((values) => share.mutate(values))}>
                          <Stack>
                            <Title order={2}>{t`Доступ исследователя к записи`}</Title>
                            <NativeSelect
                              label={t`Исследователь`}
                              data={[
                                { value: "", label: t`Выберите исследователя` },
                                ...(researchers.data ?? []).map((person) => ({
                                  value: person.userId,
                                  label: person.displayName || person.userId,
                                })),
                              ]}
                              {...shareForm.getInputProps("researcherId")}
                            />
                            <NumberInput
                              label={t`Срок доступа в днях`}
                              min={1}
                              max={365}
                              {...shareForm.getInputProps("days")}
                            />
                            <Checkbox
                              label={t`Разрешить чтение обезличенных данных`}
                              {...shareForm.getInputProps("active", { type: "checkbox" })}
                            />
                            <Text>{t`Имена, даты рождения и клинические заметки исследователю не передаются. Снимите разрешение, чтобы отозвать доступ.`}</Text>
                            <Group>
                              <Button
                                type="submit"
                                loading={share.isPending}
                                disabled={
                                  !status.data?.online ||
                                  (shareForm.values.active && (status.data?.pending ?? 0) > 0)
                                }
                              >{t`Сохранить права на сервере`}</Button>
                              <Button
                                variant="default"
                                onClick={sharingDialog.close}
                              >{t`Отмена`}</Button>
                            </Group>
                          </Stack>
                        </form>
                      </Paper>
                    )}
                    <Title order={2}>{t`История согласий`}</Title>
                    {patient.consentHistory.length === 0 && (
                      <Text>{t`Согласия ещё не зарегистрированы.`}</Text>
                    )}
                    {[...patient.consentHistory].reverse().map((event) => (
                      <Paper withBorder p="md" key={event.id}>
                        <Stack>
                          <Group>
                            <Badge>{event.kind === "granted" ? t`Согласие` : t`Отзыв`}</Badge>
                            <Text>
                              {t`Версия:`} {event.version}
                            </Text>
                          </Group>
                          <Text>{event.purpose}</Text>
                          <Text>{event.documentReference}</Text>
                          <Text>
                            {t`Получатели:`}{" "}
                            {event.recipients
                              .map(
                                (recipient) =>
                                  researchers.data?.find((person) => person.userId === recipient)
                                    ?.displayName || t`Получатель без профиля`,
                              )
                              .join(", ")}
                          </Text>
                          <Text>
                            {t`Доступны категории:`}{" "}
                            {event.scope
                              .map((category) => (category === "sex" ? t`Пол` : t`Диагнозы`))
                              .join(", ")}
                          </Text>
                          <Text>
                            {t`Зарегистрировано:`}{" "}
                            {i18n.date(new Date(event.recordedAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                          <Text>
                            {t`Действует до:`}{" "}
                            {i18n.date(new Date(event.expiresAt), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Text>
                        </Stack>
                      </Paper>
                    ))}
                    {status.data?.failures
                      .filter((failure) => failure.consentId && failure.envelope.clientId === id)
                      .map((failure) => (
                        <Alert color="yellow" key={failure.id}>
                          <Stack>
                            <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                            <Text>{failure.code}</Text>
                            <Button
                              variant="default"
                              onClick={() => restore.mutate(failure)}
                            >{t`Открыть сохранённый черновик`}</Button>
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
