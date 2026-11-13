import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Pagination,
  Paper,
  PasswordInput,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { medicalAttribution } from "@/src/lib/medical-catalog";
import { useLibrary } from "@/src/lib/use-library";

export const Route = createFileRoute("/d_/library")({ component: Library });
function Library() {
  const { t, i18n } = useLingui();
  const {
    userId,
    online,
    workspace,
    header,
    unlockForm,
    unlock,
    lock,
    resume,
    source,
    history,
    rows,
    versions,
    status,
    catalog,
    cache,
    searchForm,
    cacheResult,
    search,
    publications,
    matches,
    filters,
    selected,
    pageCount,
    page,
    pagination,
    pageRows,
    form,
    editing,
    editor,
    save,
    remove,
    restore,
    blocker,
    add,
    edit,
    reviewVersion,
    importPublication,
    matchingPublication,
    collections,
    tags,
  } = useLibrary();
  const labels = {
    toRead: t`К прочтению`,
    reading: t`Читаю`,
    included: t`Включено в подборку`,
    excluded: t`Исключено`,
  };
  const replace = (action: () => void) => {
    if (editing && form.isDirty())
      modals.openConfirmModal({
        title: t`Заменить несохранённую запись?`,
        children: (
          <Text>{t`Изменения в редакторе будут потеряны. Сохранённые записи останутся доступными.`}</Text>
        ),
        labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
        onConfirm: action,
      });
    else action();
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
                <Button onClick={blocker.reset}>{t`Остаться`}</Button>
                <Button color="red" onClick={blocker.proceed}>{t`Выйти без сохранения`}</Button>
              </Group>
            </Stack>
          </Modal>
        )}
        <Title>{t`Моя научная библиотека`}</Title>
        <Text>{t`Личные источники, подборки и заметки не зависят от выбранной организации и не открывают доступ к данным пациентов.`}</Text>
        {!userId && (
          <Alert>{t`Войдите через Google и заполните профессиональный профиль, чтобы открыть личную библиотеку.`}</Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="md">
            <form onSubmit={unlockForm.onSubmit(() => unlock.mutate())}>
              <Stack>
                <Text>{t`Для первого открытия нужен интернет и профиль врача или исследователя. После подготовки библиотека доступна без сети в пределах срока локального доступа.`}</Text>
                <PasswordInput
                  label={t`Парольная фраза личной библиотеки`}
                  autoComplete="off"
                  disabled={unlock.isPending}
                  {...unlockForm.getInputProps("passphrase")}
                />
                {!header.data && (
                  <PasswordInput
                    label={t`Повторите парольную фразу`}
                    autoComplete="off"
                    disabled={unlock.isPending}
                    {...unlockForm.getInputProps("confirmation")}
                  />
                )}
                <Button type="submit" loading={unlock.isPending}>{t`Открыть библиотеку`}</Button>
                <Anchor component={Link} to="/d/profile">{t`Мой профиль`}</Anchor>
              </Stack>
            </form>
          </Paper>
        )}
        {(header.isError ||
          unlock.isError ||
          lock.isError ||
          resume.isError ||
          save.isError ||
          remove.isError ||
          restore.isError ||
          importPublication.isError) && (
          <Alert color="red">{t`Не удалось выполнить действие с библиотекой. Проверьте профиль, парольную фразу, срок доступа и текущую версию записи. Ввод остаётся в редакторе.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Button
                variant="default"
                loading={lock.isPending}
                disabled={save.isPending || remove.isPending}
                onClick={() => replace(() => lock.mutate())}
              >{t`Заблокировать библиотеку`}</Button>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
              <Text>
                {t`Локальный доступ до:`}{" "}
                {i18n.date(workspace.expiresAt, { dateStyle: "medium", timeStyle: "short" })}
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
            {(!source.isReady || !history.isReady) && <Text>{t`Загрузка локальных данных…`}</Text>}
            <Button
              disabled={
                !workspace.canWrite() ||
                !source.isReady ||
                !history.isReady ||
                save.isPending ||
                remove.isPending
              }
              onClick={() => replace(add)}
            >{t`Добавить источник вручную`}</Button>
            {save.isSuccess && (
              <Alert color="green">{t`Источник сохранён в очереди устройства. Серверная синхронизация подтверждается отдельно.`}</Alert>
            )}
            {editing && form.values.scope === workspace.scope && (
              <Paper withBorder p="md">
                <form onSubmit={form.onSubmit((input) => save.mutate(input))}>
                  <Stack>
                    <Title order={2}>{t`Карточка источника`}</Title>
                    {form.errors._form && <Alert color="red">{form.errors._form}</Alert>}
                    {form.values.failureId && (
                      <Alert color="yellow">{t`Открыт отклонённый черновик. Сравните его с текущими данными перед сохранением.`}</Alert>
                    )}
                    <TextInput
                      label={t`Название публикации`}
                      required
                      maxLength={1000}
                      {...form.getInputProps("title")}
                    />
                    <TextInput
                      label="DOI"
                      description="10.xxxx/…"
                      maxLength={200}
                      {...form.getInputProps("doi")}
                    />
                    <TextInput label="PMID" maxLength={12} {...form.getInputProps("pmid")} />
                    <TextInput
                      label={t`Ссылка на источник (HTTPS, необязательно)`}
                      maxLength={2000}
                      {...form.getInputProps("url")}
                    />
                    <TextInput
                      label={t`Авторы`}
                      maxLength={2000}
                      {...form.getInputProps("authors")}
                    />
                    <NumberInput
                      label={t`Год публикации`}
                      min={1500}
                      max={2200}
                      clampBehavior="none"
                      {...form.getInputProps("year")}
                    />
                    <Textarea
                      label={t`Библиографическое описание`}
                      maxLength={4000}
                      {...form.getInputProps("citation")}
                    />
                    <Autocomplete
                      label={t`Подборка`}
                      data={collections}
                      maxLength={200}
                      {...form.getInputProps("collection")}
                    />
                    <TagsInput
                      label={t`Метки`}
                      description={t`До 20 меток, до 50 символов в каждой`}
                      data={tags}
                      maxTags={20}
                      {...form.getInputProps("tags")}
                    />
                    <Select
                      label={t`Статус чтения и отбора`}
                      allowDeselect={false}
                      data={Object.entries(labels).map(([value, label]) => ({ value, label }))}
                      {...form.getInputProps("status")}
                    />
                    <Textarea
                      label={t`Причина исключения источника`}
                      required={form.values.status === "excluded"}
                      maxLength={1000}
                      {...form.getInputProps("exclusionReason")}
                    />
                    <Textarea
                      label={t`Личные заметки`}
                      maxLength={5000}
                      {...form.getInputProps("notes")}
                    />
                    <Text size="sm">
                      {t`Источник исходных метаданных:`}{" "}
                      {form.values.source === "pubmed" ? "PubMed" : t`Ручной ввод`}
                    </Text>
                    <Group>
                      <Button
                        type="submit"
                        loading={save.isPending}
                        disabled={!workspace.canWrite() || remove.isPending}
                      >{t`Сохранить на устройстве`}</Button>
                      <Button
                        variant="default"
                        disabled={save.isPending}
                        onClick={() =>
                          replace(() => {
                            form.reset();
                            editor.close();
                          })
                        }
                      >{t`Отмена`}</Button>
                    </Group>
                  </Stack>
                </form>
              </Paper>
            )}
            <Title order={2}>{t`Сохранённые источники`}</Title>
            <Text>
              {t`Всего:`} {i18n.number(rows.length)}
            </Text>
            <TextInput
              label={t`Поиск в личной библиотеке`}
              value={filters.values.query}
              onChange={(event) => {
                filters.setFieldValue("query", event.currentTarget.value);
                pagination.setPage(1);
              }}
            />
            <Select
              label={t`Статус чтения и отбора`}
              allowDeselect={false}
              data={[
                { value: "all", label: t`Все статусы` },
                ...Object.entries(labels).map(([value, label]) => ({ value, label })),
              ]}
              value={filters.values.status}
              onChange={(value) => {
                filters.setFieldValue("status", value ?? "all");
                pagination.setPage(1);
              }}
            />
            <Select
              label={t`Подборка`}
              clearable
              data={collections}
              value={filters.values.collection}
              onChange={(value) => {
                filters.setFieldValue("collection", value);
                pagination.setPage(1);
              }}
            />
            <MultiSelect
              label={t`Все выбранные метки`}
              data={tags}
              value={filters.values.tags}
              onChange={(values) => {
                filters.setFieldValue("tags", values);
                pagination.setPage(1);
              }}
            />
            <Text>
              {t`Найдено:`} {i18n.number(selected.length)}
            </Text>
            {source.isReady && !selected.length && (
              <Text>{t`Сохранённых источников по выбранным условиям нет.`}</Text>
            )}
            {pageRows.map((row) => {
              const entry = row.entry;
              if (!entry) return null;
              const revisions = versions
                .filter((version) => version.itemClientId === row.clientId)
                .sort((a, b) => b.revision - a.revision);
              return (
                <Paper withBorder p="md" key={row.clientId}>
                  <Stack>
                    {entry.url ? (
                      <Anchor href={entry.url} target="_blank" rel="noopener noreferrer">
                        {entry.title}
                      </Anchor>
                    ) : (
                      <Title order={3}>{entry.title}</Title>
                    )}
                    <Text>{entry.authors}</Text>
                    <Text>{entry.citation}</Text>
                    <Group>
                      <Badge>{labels[entry.status]}</Badge>
                      {entry.collection && <Badge variant="outline">{entry.collection}</Badge>}
                      {entry.tags.map((tag) => (
                        <Badge key={tag} variant="light">
                          {tag}
                        </Badge>
                      ))}
                    </Group>
                    {entry.doi && (
                      <Anchor
                        href={`https://doi.org/${encodeURIComponent(entry.doi)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        DOI: {entry.doi}
                      </Anchor>
                    )}
                    {entry.pmid && <Text>PMID: {entry.pmid}</Text>}
                    {entry.year && <Text>{entry.year}</Text>}
                    {entry.notes && <Text>{entry.notes}</Text>}
                    {entry.exclusionReason && (
                      <Text>
                        {t`Причина исключения источника`}: {entry.exclusionReason}
                      </Text>
                    )}
                    <Text size="sm">
                      {t`Источник исходных метаданных:`}{" "}
                      {entry.source === "pubmed" ? "PubMed" : t`Ручной ввод`}
                      {entry.fetchedAt &&
                        ` · ${i18n.date(entry.fetchedAt, { dateStyle: "medium" })}`}
                    </Text>
                    <Group>
                      <Button
                        variant="default"
                        disabled={!workspace.canWrite() || save.isPending || remove.isPending}
                        onClick={() => replace(() => edit(row))}
                      >{t`Изменить источник`}</Button>
                      <Button
                        color="red"
                        variant="light"
                        disabled={!workspace.canWrite() || save.isPending || remove.isPending}
                        onClick={() =>
                          modals.openConfirmModal({
                            title: t`Удалить источник и историю?`,
                            children: (
                              <Text>{t`Карточка, заметки и прежние версии станут недоступны после удаления; сервер очистит версии после синхронизации.`}</Text>
                            ),
                            labels: { confirm: t`Удалить`, cancel: t`Отмена` },
                            onConfirm: () => remove.mutate(row),
                          })
                        }
                      >{t`Удалить`}</Button>
                    </Group>
                    <Accordion>
                      <Accordion.Item value="history">
                        <Accordion.Control>{t`История обновлений`}</Accordion.Control>
                        <Accordion.Panel>
                          <Stack>
                            {revisions.map((version) => (
                              <Paper key={version.clientId} withBorder p="sm">
                                <Stack gap="xs">
                                  <Text>
                                    {t`Версия:`} {version.revision} ·{" "}
                                    {i18n.date(version.recordedAt, {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    })}
                                  </Text>
                                  <Badge variant="light">
                                    {version.confirmed
                                      ? t`Редакция синхронизирована`
                                      : t`Редакция в очереди устройства`}
                                  </Badge>
                                  <Text size="sm">
                                    {t`Метаданные загружены:`}{" "}
                                    {version.entry.fetchedAt
                                      ? i18n.date(version.entry.fetchedAt, {
                                          dateStyle: "medium",
                                          timeStyle: "short",
                                        })
                                      : "—"}
                                  </Text>
                                  <Text>
                                    {version.entry.year ?? "—"} ·{" "}
                                    {version.entry.source === "pubmed" ? "PubMed" : t`Ручной ввод`}
                                  </Text>
                                  <Text fw={600}>{version.entry.title}</Text>
                                  <Text>{version.entry.authors}</Text>
                                  <Text>{version.entry.citation}</Text>
                                  <Text>
                                    DOI: {version.entry.doi || "—"} · PMID:{" "}
                                    {version.entry.pmid || "—"}
                                  </Text>
                                  <Text>{version.entry.url}</Text>
                                  <Text>{version.entry.collection}</Text>
                                  <Text>{version.entry.tags.join(", ")}</Text>
                                  <Text>{labels[version.entry.status]}</Text>
                                  <Text>{version.entry.notes}</Text>
                                  <Text>{version.entry.exclusionReason}</Text>
                                  <Button
                                    variant="default"
                                    disabled={
                                      !workspace.canWrite() || save.isPending || remove.isPending
                                    }
                                    onClick={() => replace(() => reviewVersion(version.entry, row))}
                                  >{t`Открыть эту версию для новой редакции`}</Button>
                                </Stack>
                              </Paper>
                            ))}
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  </Stack>
                </Paper>
              );
            })}
            <Pagination total={pageCount} value={page} onChange={pagination.setPage} />
            {status.data?.failures.map((failure) => (
              <Alert key={failure.id} color="yellow">
                <Stack>
                  <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                  <Text>{failure.code}</Text>
                  {failure.action !== "delete" ? (
                    <Button
                      variant="default"
                      disabled={save.isPending}
                      onClick={() => replace(() => restore.mutate(failure))}
                    >{t`Открыть сохранённый черновик`}</Button>
                  ) : (
                    <Text>{t`Удаление отклонено. Сравните текущую запись перед повторным удалением.`}</Text>
                  )}
                </Stack>
              </Alert>
            ))}
          </>
        )}
        <Title order={2}>{t`Поиск публикаций PubMed`}</Title>
        <Text>{t`Поиск во внешней базе требует интернета. Локально доступны загруженные метаданные; полные тексты не скачиваются. Не вводите персональные данные пациентов.`}</Text>
        <form
          onSubmit={searchForm.onSubmit((input) => {
            searchForm.setFieldValue("offset", 0);
            search.mutate({ data: { source: "pubmed", query: input.query.trim(), offset: 0 } });
          })}
        >
          <Stack>
            <TextInput
              label={t`Клиническая задача, диагноз или гипотеза`}
              minLength={2}
              maxLength={100}
              {...searchForm.getInputProps("query")}
            />
            <Button
              type="submit"
              loading={search.isPending}
              disabled={!online}
            >{t`Искать в PubMed`}</Button>
          </Stack>
        </form>
        {!online && (
          <Alert>{t`Без сети показан текстовый поиск по ранее загруженным метаданным, а не выполнение запроса PubMed.`}</Alert>
        )}
        {search.isError && (
          <Alert color="red">{t`PubMed недоступен. Личная библиотека и сохранённые метаданные остаются доступны.`}</Alert>
        )}
        {matches && search.data?.truncated && (
          <Alert>{t`По этому запросу есть ещё результаты PubMed.`}</Alert>
        )}
        {matches && search.isSuccess && !cacheResult.isPending && !cacheResult.data && (
          <Alert color="yellow">{t`Результат получен, но публичный кеш устройства не сохранён. Добавленная в личную библиотеку карточка хранится отдельно.`}</Alert>
        )}
        {(!catalog || !cache.isReady) && (
          <Text>{t`Публичный кеш ещё не подготовлен. Для первой загрузки нужен интернет.`}</Text>
        )}
        {matches && search.data && (
          <Group>
            <Text>
              {t`Всего в PubMed:`} {search.data.total ?? "…"} · {t`Начальная позиция:`}{" "}
              {searchForm.values.offset + 1}
            </Text>
            <Button
              variant="default"
              disabled={!online || search.isPending || searchForm.values.offset === 0}
              onClick={() => {
                const offset = Math.max(0, searchForm.values.offset - 20);
                searchForm.setFieldValue("offset", offset);
                search.mutate({
                  data: { source: "pubmed", query: searchForm.values.query.trim(), offset },
                });
              }}
            >{t`Предыдущие 20`}</Button>
            <Button
              variant="default"
              disabled={
                !online ||
                search.isPending ||
                !search.data.truncated ||
                !search.data.records.length ||
                searchForm.values.offset >= 9980
              }
              onClick={() => {
                const offset = searchForm.values.offset + 20;
                searchForm.setFieldValue("offset", offset);
                search.mutate({
                  data: { source: "pubmed", query: searchForm.values.query.trim(), offset },
                });
              }}
            >{t`Следующие 20`}</Button>
            {search.data.total !== null && search.data.total > 10000 && (
              <Alert>{t`NCBI ограничивает такую выдачу первыми 10 000 публикаций. Уточните запрос по теме или периоду.`}</Alert>
            )}
          </Group>
        )}
        <Text>
          {matches && search.data ? t`Результаты запроса PubMed` : t`Ранее загруженные метаданные`}
        </Text>
        {matches && search.isSuccess && publications.length === 0 && (
          <Text>{t`На выбранной странице нет публикаций.`}</Text>
        )}
        {publications.map((record) => (
          <Paper key={record.id} withBorder p="md">
            <Stack>
              <Anchor
                href={`https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(record.sourceId)}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {record.title}
              </Anchor>
              <Text>{record.bibliography?.authors.join("; ")}</Text>
              <Text>{record.description}</Text>
              {record.bibliography?.doi && <Text>DOI: {record.bibliography.doi}</Text>}
              <Text>PMID: {record.sourceId}</Text>
              <Text size="sm">
                {t`Метаданные загружены:`} {record.fetchedAt}
              </Text>
              <Button
                variant="default"
                disabled={
                  !workspace?.canWrite() ||
                  !source.isReady ||
                  !history.isReady ||
                  save.isPending ||
                  remove.isPending
                }
                onClick={() => replace(() => importPublication.mutate(record))}
              >
                {matchingPublication(record)
                  ? t`Сверить обновление метаданных`
                  : t`Добавить в личную библиотеку`}
              </Button>
            </Stack>
          </Paper>
        ))}
        <Text size="sm">
          <Anchor href={medicalAttribution.pubmed.url} target="_blank" rel="noopener noreferrer">
            {medicalAttribution.pubmed.label}
          </Anchor>{" "}
          · {medicalAttribution.pubmed.license}
        </Text>
      </Stack>
    </Container>
  );
}
