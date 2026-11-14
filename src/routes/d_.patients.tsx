import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Pagination,
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  NativeSelect,
  MultiSelect,
  NumberInput,
  Checkbox,
  Paper,
  PasswordInput,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import "dayjs/locale/ru";
import { useForm } from "@mantine/form";
import { usePagination } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import {
  defaultPatientSearch,
  patientSearchSchema,
  possiblePatientDuplicates,
  searchPatients,
} from "@/src/lib/patient-search";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";
import { failureDetails } from "@/src/observability/events";

export const Route = createFileRoute("/d_/patients")({ component: Patients });
function Patients() {
  const { t, i18n } = useLingui();
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
    sharing,
    sharingDialog,
    consenting,
    consentDialog,
    patientForm,
    consentForm,
    shareForm,
    save,
    remove,
    share,
    consent,
    restore,
    lock,
    resume,
    researchers,
    downloaded,
    status,
  } = usePatientWorkspace();
  const searchForm = useForm({
    initialValues: { ...defaultPatientSearch, scope: "" },
    onValuesChange: () => pagination.first(),
  });
  const currentSearch =
    workspace && searchForm.values.scope === workspace.scope
      ? searchForm.values
      : defaultPatientSearch;
  const filtered = searchPatients(rows, opened?.role ?? "researcher", currentSearch, Date.now());
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const pagination = usePagination({ total: pageCount });
  const page = Math.min(pagination.active, pageCount);
  const pageRows = filtered.slice((page - 1) * 25, page * 25);
  const duplicates = possiblePatientDuplicates(rows, opened?.role ?? "researcher");
  const diagnosisOptions = [
    ...new Set(
      rows.flatMap((row) =>
        opened?.role === "doctor" || row.consentScope.includes("diagnoses")
          ? row.diagnosisCodes.map((code) => code.trim().toUpperCase()).filter(Boolean)
          : [],
      ),
    ),
  ].sort();

  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/d">{t`На главную`}</Anchor>
        <Title>{t`Пациенты`}</Title>
        {!userId && (
          <Alert>
            {t`Войдите и подтвердите принадлежность к организации, чтобы работать с пациентами.`}
            <Anchor component={Link} to="/d/profile">{t`Открыть профиль`}</Anchor>
          </Alert>
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
                  minLength={12}
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
                {options.length === 0 && (
                  <Text>{t`Нет подтверждённой организации или подготовленного офлайн-пространства.`}</Text>
                )}
                {!online && (
                  <Text>{t`Без сети доступны только ранее подготовленные пространства с действующим сроком доступа.`}</Text>
                )}
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError ||
          save.isError ||
          remove.isError ||
          lock.isError ||
          resume.isError ||
          share.isError ||
          consent.isError ||
          restore.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {share.isError && failureDetails(share.error).code === "CONSENT_REQUIRED" && (
          <Alert color="red">{t`Для выдачи доступа сначала зарегистрируйте согласие пациента для выбранного исследователя и дождитесь синхронизации.`}</Alert>
        )}
        {consent.isError && failureDetails(consent.error).code === "CONSENT_EXPIRED" && (
          <Alert color="red">{t`Срок согласия истёк. Для нового срока требуется новая версия с подтверждающим документом.`}</Alert>
        )}
        {workspace && opened && (
          <>
            <Group>
              <Badge>
                {opened.role === "doctor"
                  ? t`Врач: создание, чтение, изменение и удаление`
                  : t`Исследователь: только чтение`}
              </Badge>
              <Button
                variant="default"
                disabled={save.isPending || remove.isPending}
                onClick={() => lock.mutate()}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            <Text>{t`Сохранение на устройстве и отправка на сервер — разные статусы. Неотправленные изменения остаются в шифруемой очереди.`}</Text>
            <Text>{t`В очереди: ${status.data?.pending ?? 0}`}</Text>
            {!status.data?.leader && (
              <Alert>{t`Изменения доступны в другой открытой вкладке этого пространства. Здесь можно читать данные.`}</Alert>
            )}
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
            {Date.now() >= workspace.expiresAt && (
              <Alert color="red">{t`Срок локального доступа истёк. Для продолжения подключитесь и подтвердите доступ заново.`}</Alert>
            )}
            {opened.role === "doctor" && (
              <Button
                disabled={!status.data?.leader || !downloaded.isReady}
                onClick={() => {
                  patientForm.reset();
                  patientForm.setFieldValue("workspaceScope", workspace.scope);
                  editor.open();
                }}
              >{t`Добавить пациента`}</Button>
            )}
            {(save.isSuccess || remove.isSuccess) && (
              <Alert>{t`Изменение сохранено на устройстве. Состояние отправки показано отдельно.`}</Alert>
            )}
            {editing && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form
                  onSubmit={patientForm.onSubmit((values) =>
                    save.mutateAsync(values).catch(() => undefined),
                  )}
                >
                  <Stack>
                    <TextInput
                      label={t`Имя пациента`}
                      required
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
                      {...patientForm.getInputProps("notes")}
                    />
                    <Group>
                      <Button
                        type="submit"
                        disabled={!status.data?.leader || !downloaded.isReady}
                        loading={save.isPending}
                      >{t`Сохранить на устройстве`}</Button>
                      <Button variant="default" onClick={editor.close}>{t`Отмена`}</Button>
                    </Group>
                  </Stack>
                </form>
              </Paper>
            )}
            {consent.isSuccess && (
              <Alert>{t`Согласие или отзыв сохранены на устройстве. Для выдачи доступа дождитесь отправки на сервер.`}</Alert>
            )}
            {consenting && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form
                  onSubmit={consentForm.onSubmit((values) =>
                    consent.mutateAsync(values).catch(() => undefined),
                  )}
                >
                  <Stack>
                    <Title order={2}>{t`Согласие на исследовательское использование данных`}</Title>
                    <Text>{t`Врач фиксирует уже полученное согласие или его отзыв. Запись в системе не заменяет подпись пациента.`}</Text>
                    <NativeSelect
                      label={t`Действие`}
                      data={[
                        { value: "granted", label: t`Зарегистрировать новую версию согласия` },
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
                                !(researchers.data ?? []).some((person) => person.userId === id),
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
                      <Button variant="default" onClick={consentDialog.close}>{t`Отмена`}</Button>
                    </Group>
                    <Title order={3}>{t`История согласий`}</Title>
                    {rows
                      .find((row) => row.clientId === consentForm.values.clientId)
                      ?.consentHistory.map((event) => (
                        <Paper key={event.id} withBorder p="xs">
                          <Stack gap="xs">
                            <Text>
                              {event.version} · {event.kind === "granted" ? t`Согласие` : t`Отзыв`}
                            </Text>
                            <Text>{event.purpose}</Text>
                            <Text>{event.documentReference}</Text>
                            <Text>
                              {new Intl.DateTimeFormat(i18n.locale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(event.recordedAt)}
                            </Text>
                          </Stack>
                        </Paper>
                      ))}
                  </Stack>
                </form>
              </Paper>
            )}
            {share.isSuccess && <Alert>{t`Права доступа обновлены на сервере.`}</Alert>}
            {sharing && opened.role === "doctor" && (
              <Paper withBorder p="md">
                <form
                  onSubmit={shareForm.onSubmit((values) =>
                    share.mutateAsync(values).catch(() => undefined),
                  )}
                >
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
                      <Button variant="default" onClick={sharingDialog.close}>{t`Отмена`}</Button>
                    </Group>
                  </Stack>
                </form>
              </Paper>
            )}
            <Accordion
              onChange={(value) => {
                if (value === "search" && searchForm.values.scope !== workspace.scope)
                  searchForm.setValues({ ...defaultPatientSearch, scope: workspace.scope });
              }}
            >
              <Accordion.Item value="search">
                <Accordion.Control>{t`Поиск и фильтры пациентов`}</Accordion.Control>
                <Accordion.Panel>
                  {searchForm.values.scope === workspace.scope && (
                    <Stack>
                      <TextInput
                        label={
                          opened.role === "doctor"
                            ? t`Имя или идентификатор пациента`
                            : t`Обезличенный идентификатор пациента`
                        }
                        maxLength={200}
                        {...searchForm.getInputProps("query")}
                      />
                      <MultiSelect
                        label={t`Все указанные диагнозы`}
                        data={diagnosisOptions}
                        searchable
                        clearable
                        maxValues={100}
                        {...searchForm.getInputProps("diagnoses")}
                      />
                      <Text>{t`Коды диагнозов сравниваются целиком без учёта регистра. Недоступные по согласию поля не считаются пустыми.`}</Text>
                      <NativeSelect
                        label={t`Пол`}
                        data={[
                          { value: "any", label: t`Любой` },
                          { value: "female", label: t`Женский` },
                          { value: "male", label: t`Мужской` },
                          { value: "unknown", label: t`Не указан` },
                          ...(opened.role === "researcher"
                            ? [{ value: "unavailable", label: t`Не разрешено согласием` }]
                            : []),
                        ]}
                        {...searchForm.getInputProps("sex")}
                      />
                      {opened.role === "doctor" && (
                        <>
                          <DateInput
                            label={t`Дата рождения: от`}
                            locale={i18n.locale}
                            clearable
                            value={searchForm.values.birthFrom || null}
                            onChange={(value) => searchForm.setFieldValue("birthFrom", value ?? "")}
                          />
                          <DateInput
                            label={t`Дата рождения: до`}
                            locale={i18n.locale}
                            clearable
                            value={searchForm.values.birthTo || null}
                            onChange={(value) => searchForm.setFieldValue("birthTo", value ?? "")}
                          />
                        </>
                      )}
                      {!patientSearchSchema.safeParse(searchForm.values).success && (
                        <Alert color="red">{t`Проверьте диапазон дат: начало не должно быть позже окончания.`}</Alert>
                      )}
                      <NativeSelect
                        label={t`Сортировка пациентов`}
                        data={[
                          { value: "recent", label: t`По последнему изменению` },
                          { value: "id", label: t`По идентификатору` },
                          ...(opened.role === "doctor"
                            ? [{ value: "name", label: t`По имени` }]
                            : []),
                        ]}
                        {...searchForm.getInputProps("sort")}
                      />
                      <Button
                        variant="default"
                        onClick={() =>
                          searchForm.setValues({ ...defaultPatientSearch, scope: workspace.scope })
                        }
                      >{t`Сбросить критерии`}</Button>
                    </Stack>
                  )}
                </Accordion.Panel>
              </Accordion.Item>
              {opened.role === "doctor" && (
                <Accordion.Item value="duplicates">
                  <Accordion.Control>{t`Возможные дубликаты пациентов`}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack>
                      <Text>{t`Совпадение имени и даты рождения — повод для проверки, а не подтверждение личности. Записи, согласия и история не объединяются автоматически.`}</Text>
                      {duplicates.length === 0 && (
                        <Text>{t`Совпадений в загруженном наборе не найдено.`}</Text>
                      )}
                      <Text>
                        {t`Групп совпадений:`} {duplicates.length}
                      </Text>
                      {duplicates.slice(0, 20).map((group) => (
                        <Paper withBorder p="md" key={group[0]!.clientId}>
                          <Stack>
                            <Title order={3}>{group[0]!.fullName}</Title>
                            <Text>
                              {i18n.date(new Date(`${group[0]!.birthDate}T12:00:00`), {
                                dateStyle: "medium",
                              })}
                            </Text>
                            {group.map((record) => (
                              <Anchor
                                key={record.clientId}
                                renderRoot={(props) => (
                                  <Link
                                    {...props}
                                    to="/d/patients/$id"
                                    params={{ id: record.clientId }}
                                  />
                                )}
                              >
                                {record.clientId}
                              </Anchor>
                            ))}
                          </Stack>
                        </Paper>
                      ))}
                      {duplicates.length > 20 && (
                        <Text>{t`Показаны первые 20 групп совпадений.`}</Text>
                      )}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              )}
            </Accordion>
            <Text>
              {t`Найдено:`} {i18n.number(filtered.length)} / {i18n.number(rows.length)}
            </Text>
            <Text>{t`Поиск выполняется в загруженном наборе выбранной организации и работает без сети.`}</Text>
            <Table.ScrollContainer minWidth={700}>
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t`Пациент`}</Table.Th>
                    <Table.Th>{t`Диагнозы`}</Table.Th>
                    <Table.Th>{t`Версия`}</Table.Th>
                    <Table.Th>{t`Действия`}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {pageRows.map((row) => (
                    <Table.Tr key={row.clientId}>
                      <Table.Td>
                        <Anchor
                          renderRoot={(props) => (
                            <Link {...props} to="/d/patients/$id" params={{ id: row.clientId }} />
                          )}
                        >
                          {row.fullName || row.clientId}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        {opened.role === "researcher" && !row.consentScope.includes("diagnoses")
                          ? t`Не разрешено согласием`
                          : row.diagnosisCodes.join(", ")}
                      </Table.Td>
                      <Table.Td>{row.revision}</Table.Td>
                      <Table.Td>
                        {opened.role === "doctor" && (
                          <Group>
                            <Button
                              variant="default"
                              onClick={() => {
                                patientForm.setValues({
                                  ...row,
                                  expectedRevision: row.revision,
                                  expectedHistoryId: row.historyId ?? null,
                                  workspaceScope: workspace.scope,
                                  diagnosisCodes: row.diagnosisCodes.join(", "),
                                  failureId: "",
                                });
                                editor.open();
                              }}
                            >{t`Изменить`}</Button>
                            <Button
                              variant="default"
                              onClick={() => {
                                const latest = row.consentHistory.at(-1);
                                consent.reset();
                                share.reset();
                                consentForm.setValues({
                                  archivedExpiresAt: 0,
                                  failureId: "",
                                  clientId: row.clientId,
                                  expectedRevision: row.revision,
                                  expectedHistoryId: row.historyId ?? null,
                                  workspaceScope: workspace.scope,
                                  kind: "granted",
                                  purpose: latest?.purpose ?? "",
                                  recipients: latest?.recipients ?? [],
                                  scope: latest?.scope ?? ["sex", "diagnoses"],
                                  documentReference: "",
                                  days: 30,
                                  attested: false,
                                });
                                consentDialog.open();
                              }}
                            >{t`Согласия`}</Button>
                            <Button
                              variant="default"
                              disabled={!status.data?.online}
                              onClick={() => {
                                shareForm.setFieldValue("clientId", row.clientId);
                                shareForm.setFieldValue("workspaceScope", workspace.scope);
                                sharingDialog.open();
                              }}
                            >{t`Доступ исследователю`}</Button>
                            <Button
                              color="red"
                              onClick={() =>
                                modals.openConfirmModal({
                                  title: t`Удалить данные пациента?`,
                                  children: <Text>{row.fullName}</Text>,
                                  labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                                  onConfirm: () =>
                                    remove.mutate({
                                      clientId: row.clientId,
                                      expectedRevision: row.revision,
                                      expectedHistoryId: row.historyId ?? null,
                                      workspaceScope: workspace.scope,
                                    }),
                                })
                              }
                            >{t`Удалить`}</Button>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Pagination total={pageCount} value={page} onChange={pagination.setPage} />
            {downloaded.isReady && rows.length > 0 && filtered.length === 0 && (
              <Text>{t`Нет пациентов, соответствующих текущим критериям.`}</Text>
            )}
            {downloaded.isReady && rows.length === 0 && (
              <Text>{t`Доступных записей пока нет.`}</Text>
            )}
            {status.data?.failures.map((failure) => (
              <Alert key={failure.id} color="red">
                <Stack>
                  <Text>
                    {failure.code === "REVISION_CONFLICT"
                      ? t`Запись изменена другим участником. Проверьте актуальные данные перед повторным сохранением.`
                      : t`Сервер отклонил изменение. Локальная версия сохранена для разбора.`}
                  </Text>
                  {failure.action === "delete" ? (
                    <Stack>
                      <Text>{t`Удаление не выполнено. Откройте актуальную карту и повторно рассмотрите удаление; исходные данные сохранены в архиве решения.`}</Text>
                      <Anchor
                        renderRoot={(props) => (
                          <Link
                            {...props}
                            to="/d/patients/$id"
                            params={{ id: failure.envelope.clientId }}
                          />
                        )}
                      >{t`Открыть актуальную карту`}</Anchor>
                    </Stack>
                  ) : (
                    <Button
                      variant="default"
                      onClick={() => restore.mutate(failure)}
                    >{t`Восстановить данные в форме`}</Button>
                  )}
                </Stack>
              </Alert>
            ))}
          </>
        )}
      </Stack>
    </Container>
  );
}
