import { useLingui } from "@lingui/react/macro";
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  Modal,
  MultiSelect,
  Select,
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

import {
  creditRoleSchema,
  currentDeclaration,
  currentDecision,
} from "@/src/lib/research-credit-model";
import { useResearchCredits } from "@/src/lib/use-research-credits";

export const Route = createFileRoute("/d_/projects_/$id/credits")({ component: ResearchCredits });
function ResearchCredits() {
  const { t, i18n } = useLingui();
  const { id } = Route.useParams();
  const {
    userId,
    workspace,
    online,
    options,
    headers,
    unlockForm,
    unlock,
    lock,
    resume,
    status,
    downloaded,
    localWork,
    project,
    entries,
    agreements,
    members,
    names,
    canWrite,
    manager,
    editing,
    editor,
    form,
    begin,
    newAgreement,
    decide,
    failures,
    saveCredit,
    restore,
    blocker,
  } = useResearchCredits(id);
  const roles = {
    conceptualization: t`Замысел исследования`,
    dataCuration: t`Подготовка и сопровождение данных`,
    formalAnalysis: t`Формальный анализ`,
    fundingAcquisition: t`Привлечение финансирования`,
    investigation: t`Проведение исследования`,
    methodology: t`Методология`,
    projectAdministration: t`Администрирование проекта`,
    resources: t`Ресурсы`,
    software: t`Программное обеспечение`,
    supervision: t`Научное руководство`,
    validation: t`Проверка результатов`,
    visualization: t`Визуализация`,
    writingOriginalDraft: t`Подготовка рукописи`,
    writingReviewEditing: t`Рецензирование и редактирование рукописи`,
  };
  const criteria = {
    substantialContribution: t`Подтверждаю существенный вклад в замысел, данные или анализ`,
    manuscriptWork: t`Участвовал в подготовке или содержательной научной переработке рукописи`,
    finalApproval: t`Одобряю указанную в соглашении окончательную версию работы`,
    accountability: t`Принимаю ответственность за добросовестность и точность работы`,
  };
  const replace = (action: () => void) => {
    if (editing && form.isDirty())
      modals.openConfirmModal({
        title: t`Заменить несохранённый черновик?`,
        children: <Text>{t`Несохранённый ввод будет закрыт.`}</Text>,
        labels: { confirm: t`Продолжить`, cancel: t`Остаться` },
        onConfirm: action,
      });
    else action();
  };
  const agreementLabel = (clientId: string) => {
    const row = entries.find((row) => row.clientId === clientId);
    return row?.values.kind === "agreement"
      ? `${row.values.outputTitle} — ${t`Версия:`} ${row.values.version}`
      : t`Соглашение недоступно`;
  };
  const target = entries.find((row) => row.clientId === form.values.agreementClientId);
  return (
    <Container component="main" py="sm">
      <Stack gap="sm">
        {blocker.status === "blocked" && (
          <Modal
            opened
            onClose={blocker.reset}
            title={t`Покинуть страницу с несохранёнными изменениями?`}
          >
            <Group>
              <Button onClick={blocker.proceed}>{t`Продолжить`}</Button>
              <Button variant="default" onClick={blocker.reset}>{t`Остаться`}</Button>
            </Group>
          </Modal>
        )}
        <Anchor component={Link} to="/d/projects">{t`Мои исследования`}</Anchor>
        <Title>{t`Вклад, интересы и авторство`}</Title>
        <Text>{t`Личные декларации участников и согласование авторов конкретной работы. Данные пациентов сюда не вносите.`}</Text>
        <Alert>
          <Text>{t`Роли CRediT описывают вклад и сами по себе не устанавливают авторство. Подтверждения фиксирует каждый участник за себя; приложение не подтверждает достоверность заявлений и не разрешает споры об авторстве.`}</Text>
          <Anchor href="https://credit.niso.org/" target="_blank" rel="noreferrer">
            CRediT / NISO
          </Anchor>
          <Text>
            <Anchor
              href="https://www.icmje.org/recommendations/browse/roles-and-responsibilities/defining-the-role-of-authors-and-contributors.html"
              target="_blank"
              rel="noreferrer"
            >
              ICMJE
            </Anchor>
          </Text>
        </Alert>
        {!userId && (
          <Alert>{t`Войдите через Google, чтобы открыть рабочее пространство. Для первого входа нужен интернет.`}</Alert>
        )}
        {userId && !workspace && (
          <Paper withBorder p="sm">
            <form
              onSubmit={unlockForm.onSubmit((values) =>
                unlock.mutate({ organizationId: values.organizationId }),
              )}
            >
              <Stack gap="sm">
                <Text>{t`Сохраните парольную фразу: без неё локальные данные и очередь изменений не восстановить.`}</Text>
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
                  (row) => row.organizationId === unlockForm.values.organizationId,
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
                  disabled={!options.length}
                >{t`Открыть рабочее пространство`}</Button>
              </Stack>
            </form>
          </Paper>
        )}
        {(unlock.isError || lock.isError || resume.isError) && (
          <Alert color="red">{t`Операция не выполнена. Проверьте парольную фразу, срок доступа и разрешения. При ошибке сохранения не закрывайте форму.`}</Alert>
        )}
        {workspace && (
          <>
            <Group>
              <Badge>
                {status.data?.online ? t`Синхронизация подключена` : t`Локальная работа`}
              </Badge>
              <Text>
                {t`В очереди:`} {status.data?.pending ?? "…"}
              </Text>
              <Button
                variant="default"
                disabled={!online}
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >{t`Повторно проверить сессию и доступ`}</Button>
              <Button
                variant="default"
                disabled={saveCredit.isPending}
                onClick={() => replace(() => lock.mutate())}
              >{t`Заблокировать пространство`}</Button>
            </Group>
            {!downloaded.isReady || !localWork.isReady ? (
              <Text>{t`Загрузка локальных данных…`}</Text>
            ) : !project ? (
              <Alert>{t`Исследование недоступно в выбранном пространстве.`}</Alert>
            ) : (
              <>
                <Title order={2}>{project.title}</Title>
                <Text>{t`Записи видны команде проекта. Новая декларация или версия соглашения сохраняет историю; старое принятие не переносится на новые условия или изменённую декларацию интересов.`}</Text>
                {canWrite && (
                  <Group>
                    <Button
                      disabled={saveCredit.isPending}
                      onClick={() => replace(() => begin())}
                    >{t`Мой вклад и интересы`}</Button>
                    {manager && (
                      <Button
                        variant="default"
                        disabled={saveCredit.isPending}
                        onClick={() => replace(newAgreement)}
                      >{t`Предложить соглашение об авторстве`}</Button>
                    )}
                  </Group>
                )}
                {saveCredit.isError && (
                  <Alert color="red">{t`Не удалось сохранить запись. Проверьте права, текущую версию, состав команды и декларацию. Ввод остаётся в форме.`}</Alert>
                )}
                {saveCredit.isSuccess && (
                  <Alert color="green">{t`Запись сохранена в очереди устройства. Подтверждение сервера отображается отдельно.`}</Alert>
                )}
                {editing &&
                  canWrite &&
                  form.values.scope === workspace.scope &&
                  form.values.projectId === id && (
                    <Paper withBorder p="sm">
                      <form onSubmit={form.onSubmit((values) => saveCredit.mutate(values))}>
                        <Stack gap="sm">
                          {Object.keys(form.errors).length > 0 && (
                            <Alert color="red">{t`Проверьте обязательные поля, авторов и подтверждения.`}</Alert>
                          )}
                          {form.values.failureId && (
                            <Alert color="yellow">{t`Открыто отклонённое предложение. Сравните его с текущими данными. Решение по устаревшему соглашению не переносится: откройте новую версию и рассмотрите её заново.`}</Alert>
                          )}
                          {form.values.kind === "declaration" && (
                            <>
                              <Title order={3}>{t`Моя декларация`}</Title>
                              <MultiSelect
                                label={t`Роли CRediT`}
                                data={creditRoleSchema.options.map((value) => ({
                                  value,
                                  label: roles[value],
                                }))}
                                searchable
                                {...form.getInputProps("roles")}
                              />
                              <Textarea
                                label={t`Описание моего вклада`}
                                required
                                maxLength={5000}
                                {...form.getInputProps("contribution")}
                              />
                              <Select
                                allowDeselect={false}
                                label={t`Есть относящиеся к работе интересы`}
                                data={[
                                  { value: "", label: t`Выберите ответ` },
                                  { value: "yes", label: t`Да` },
                                  { value: "no", label: t`Нет` },
                                ]}
                                {...form.getInputProps("hasInterests")}
                              />
                              <Textarea
                                label={t`Раскрытие интересов или явное заявление об их отсутствии`}
                                required
                                maxLength={5000}
                                {...form.getInputProps("interests")}
                              />
                            </>
                          )}
                          {form.values.kind === "agreement" && (
                            <>
                              <Title order={3}>{t`Предложение об авторстве`}</Title>
                              <Text>
                                {t`Версия:`} {form.values.version}
                              </Text>
                              <TextInput
                                label={t`Название работы`}
                                required
                                maxLength={300}
                                {...form.getInputProps("outputTitle")}
                              />
                              <Textarea
                                label={t`Условия и точное обозначение рассматриваемой редакции рукописи`}
                                required
                                maxLength={10000}
                                {...form.getInputProps("terms")}
                              />
                              <Text>{t`Порядок ниже является предлагаемым порядком авторов. Принятие требуется отдельно от каждого указанного автора.`}</Text>
                              {form.values.authors.map((author, index) => (
                                <Group key={index}>
                                  <Select
                                    allowDeselect={false}
                                    label={`${t`Автор`} ${index + 1}`}
                                    value={author.userId}
                                    data={[
                                      { value: "", label: t`Выберите участника` },
                                      ...members
                                        .filter((row) => row.active && row.role !== "viewer")
                                        .map((row) => ({
                                          value: row.userId,
                                          label: names.get(row.userId) ?? row.userId,
                                        })),
                                      ...(author.userId &&
                                      !members.some(
                                        (row) =>
                                          row.active &&
                                          row.role !== "viewer" &&
                                          row.userId === author.userId,
                                      )
                                        ? [{ value: author.userId, label: author.userId }]
                                        : []),
                                    ]}
                                    onChange={(value) =>
                                      form.setFieldValue(`authors.${index}.userId`, value ?? "")
                                    }
                                  />
                                  <Button
                                    variant="default"
                                    disabled={index === 0}
                                    onClick={() =>
                                      form.reorderListItem("authors", {
                                        from: index,
                                        to: index - 1,
                                      })
                                    }
                                  >{t`Вверх`}</Button>
                                  <Button
                                    variant="default"
                                    disabled={index === form.values.authors.length - 1}
                                    onClick={() =>
                                      form.reorderListItem("authors", {
                                        from: index,
                                        to: index + 1,
                                      })
                                    }
                                  >{t`Вниз`}</Button>
                                  <Button
                                    variant="default"
                                    onClick={() => form.removeListItem("authors", index)}
                                  >{t`Удалить`}</Button>
                                </Group>
                              ))}
                              <Button
                                variant="default"
                                disabled={form.values.authors.length >= 200}
                                onClick={() => form.insertListItem("authors", { userId: "" })}
                              >{t`Добавить автора`}</Button>
                              <Select
                                allowDeselect={false}
                                label={t`Автор для переписки`}
                                data={[
                                  { value: "", label: t`Выберите участника` },
                                  ...form.values.authors
                                    .filter((row) => row.userId)
                                    .map((row) => ({
                                      value: row.userId,
                                      label: names.get(row.userId) ?? row.userId,
                                    })),
                                ]}
                                {...form.getInputProps("correspondingAuthorId")}
                              />
                              {form.values.version > 1 && (
                                <Textarea
                                  label={t`Причина изменения договорённости`}
                                  required
                                  maxLength={2000}
                                  {...form.getInputProps("reason")}
                                />
                              )}
                            </>
                          )}
                          {form.values.kind === "decision" && (
                            <>
                              <Title order={3}>{t`Моё решение по авторству`}</Title>
                              {target?.values.kind === "agreement" && (
                                <Paper withBorder p="sm">
                                  <Stack gap="sm">
                                    <Text fw={600}>{target.values.outputTitle}</Text>
                                    <Text>
                                      {t`Версия:`} {target.values.version}
                                    </Text>
                                    <Text>{target.values.terms}</Text>
                                    {target.values.authors.map((author, index) => (
                                      <Text key={author}>
                                        {index + 1}. {names.get(author) ?? author}
                                      </Text>
                                    ))}
                                  </Stack>
                                </Paper>
                              )}
                              <Text>{t`Решение связано с этой версией соглашения и вашей текущей декларацией. Если декларации ещё нет, сначала сохраните её.`}</Text>
                              <Select
                                allowDeselect={false}
                                label={t`Решение`}
                                data={[
                                  { value: "", label: t`Выберите ответ` },
                                  { value: "accepted", label: t`Принимаю` },
                                  { value: "declined", label: t`Отклоняю` },
                                ]}
                                {...form.getInputProps("decision")}
                              />
                              {form.values.decision === "accepted" &&
                                Object.entries(criteria).map(([key, label]) => (
                                  <Checkbox
                                    key={key}
                                    label={label}
                                    {...form.getInputProps(`attestations.${key}`, {
                                      type: "checkbox",
                                    })}
                                  />
                                ))}
                              <Textarea
                                label={t`Комментарий к решению`}
                                required={form.values.decision === "declined"}
                                maxLength={3000}
                                {...form.getInputProps("comment")}
                              />
                            </>
                          )}
                          <Group>
                            <Button
                              type="submit"
                              loading={saveCredit.isPending}
                            >{t`Сохранить на устройстве`}</Button>
                            <Button
                              variant="default"
                              disabled={saveCredit.isPending}
                              onClick={() => replace(() => editor.close())}
                            >{t`Закрыть`}</Button>
                          </Group>
                        </Stack>
                      </form>
                    </Paper>
                  )}
                <Title order={2}>{t`Декларации участников`}</Title>
                {[
                  ...new Set(
                    entries
                      .filter((row) => row.values.kind === "declaration")
                      .map((row) => row.createdBy),
                  ),
                ].map((actor) => {
                  const row = currentDeclaration(entries, actor);
                  if (row?.values.kind !== "declaration") return null;
                  return (
                    <Paper withBorder p="sm" key={actor}>
                      <Stack gap="sm">
                        <Title order={3}>{names.get(actor) ?? actor}</Title>
                        <Text>{row.values.roles.map((role) => roles[role]).join(", ")}</Text>
                        <Text>{row.values.contribution}</Text>
                        <Badge>
                          {row.values.hasInterests
                            ? t`Интересы раскрыты`
                            : t`Заявлено отсутствие интересов`}
                        </Badge>
                        <Text>{row.values.interests}</Text>
                        <Text>
                          {i18n.date(new Date(row.createdAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </Text>
                        <Badge>
                          {row.delivery === "confirmed"
                            ? t`Подтверждено сервером`
                            : t`Ожидает подтверждения`}
                        </Badge>
                      </Stack>
                    </Paper>
                  );
                })}
                {!entries.some((row) => row.values.kind === "declaration") && (
                  <Text>{t`Деклараций пока нет.`}</Text>
                )}
                <Title order={2}>{t`Договорённости об авторстве`}</Title>
                {agreements.map(
                  (row) =>
                    row.values.kind === "agreement" && (
                      <Paper withBorder p="sm" key={row.clientId}>
                        <Stack gap="sm">
                          <Title order={3}>{row.values.outputTitle}</Title>
                          <Text>
                            {t`Версия:`} {row.values.version}
                          </Text>
                          <Text>{row.values.terms}</Text>
                          <Text>
                            {t`Автор для переписки`}:{" "}
                            {names.get(row.values.correspondingAuthorId) ??
                              row.values.correspondingAuthorId}
                          </Text>
                          <Badge>
                            {row.delivery === "confirmed"
                              ? t`Подтверждено сервером`
                              : t`Ожидает подтверждения`}
                          </Badge>
                          {row.values.authors.map((author, index) => {
                            const decision = currentDecision(entries, row.clientId, author);
                            const declaration = currentDeclaration(entries, author);
                            const active = members.some(
                              (member) =>
                                member.userId === author &&
                                member.active &&
                                member.role !== "viewer",
                            );
                            const fresh =
                              decision?.values.kind === "decision" &&
                              decision.values.declarationClientId === declaration?.clientId;
                            return (
                              <Paper withBorder p="sm" key={author}>
                                <Stack gap="sm">
                                  <Text>
                                    {index + 1}. {names.get(author) ?? author}
                                  </Text>
                                  <Badge>
                                    {!active
                                      ? t`Участие автора прекращено`
                                      : !fresh
                                        ? t`Требуется новое решение`
                                        : decision?.values.kind === "decision" &&
                                            decision.values.decision === "accepted"
                                          ? t`Принимает`
                                          : t`Отклоняет`}
                                  </Badge>
                                  {decision?.values.kind === "decision" && (
                                    <>
                                      <Text>{decision.values.comment}</Text>
                                      <Badge>
                                        {decision.delivery === "confirmed"
                                          ? t`Подтверждено сервером`
                                          : t`Ожидает подтверждения`}
                                      </Badge>
                                    </>
                                  )}
                                </Stack>
                              </Paper>
                            );
                          })}
                          {canWrite && row.values.authors.includes(userId!) && (
                            <Button
                              variant="default"
                              disabled={saveCredit.isPending}
                              onClick={() => replace(() => decide(row.clientId))}
                            >{t`Рассмотреть за себя`}</Button>
                          )}
                          {canWrite && manager && (
                            <Button
                              variant="default"
                              disabled={saveCredit.isPending}
                              onClick={() => replace(() => begin(row.values))}
                            >{t`Предложить новую версию`}</Button>
                          )}
                        </Stack>
                      </Paper>
                    ),
                )}
                {!agreements.length && <Text>{t`Соглашений пока нет.`}</Text>}
                <Accordion>
                  <Accordion.Item value="history">
                    <Accordion.Control>{t`История заявлений и решений`}</Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap="sm">
                        {entries.map((row) => (
                          <Paper withBorder p="sm" key={row.clientId}>
                            <Stack gap="sm">
                              <Text>
                                {names.get(row.createdBy) ?? row.createdBy} —{" "}
                                {i18n.date(new Date(row.createdAt), {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                })}
                              </Text>
                              <Text>
                                {row.values.kind === "declaration"
                                  ? t`Декларация вклада и интересов`
                                  : row.values.kind === "agreement"
                                    ? t`Предложение об авторстве`
                                    : t`Решение по авторству`}
                              </Text>
                              {row.values.kind === "declaration" ? (
                                <>
                                  <Text>
                                    {row.values.roles.map((role) => roles[role]).join(", ")}
                                  </Text>
                                  <Text>{row.values.contribution}</Text>
                                  <Text>{row.values.interests}</Text>
                                </>
                              ) : row.values.kind === "agreement" ? (
                                <>
                                  <Text>
                                    {row.values.outputTitle} — {row.values.version}
                                  </Text>
                                  <Text>{row.values.terms}</Text>
                                  <Text>
                                    {row.values.authors
                                      .map(
                                        (actor, index) =>
                                          `${index + 1}. ${names.get(actor) ?? actor}`,
                                      )
                                      .join("; ")}
                                  </Text>
                                  <Text>{row.values.reason}</Text>
                                </>
                              ) : (
                                <>
                                  <Text>
                                    {row.values.decision === "accepted" ? t`Принимаю` : t`Отклоняю`}
                                  </Text>
                                  <Text>{row.values.comment}</Text>
                                  <Text>{agreementLabel(row.values.agreementClientId)}</Text>
                                  {Object.entries(row.values.attestations).map(([key, value]) => (
                                    <Text key={key}>
                                      {criteria[key as keyof typeof criteria]}:{" "}
                                      {value ? t`Да` : t`Нет`}
                                    </Text>
                                  ))}
                                </>
                              )}
                              <Badge>
                                {row.delivery === "confirmed"
                                  ? t`Подтверждено сервером`
                                  : t`Ожидает подтверждения`}
                              </Badge>
                            </Stack>
                          </Paper>
                        ))}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
                {failures.isError && (
                  <Alert color="red">
                    {t`Не удалось прочитать сохранённые решения. Повторите попытку.`}
                    <Button
                      variant="default"
                      onClick={() => void failures.refetch()}
                    >{t`Повторить`}</Button>
                  </Alert>
                )}
                {failures.data?.map((failure) => (
                  <Alert color="yellow" key={failure.id}>
                    <Stack gap="sm">
                      <Text>{t`Сервер отклонил изменение. Сохранённое решение не применяется автоматически.`}</Text>
                      <Text>{failure.code}</Text>
                      <Button
                        variant="default"
                        disabled={saveCredit.isPending}
                        onClick={() => replace(() => restore.mutate(failure))}
                      >{t`Открыть сохранённый черновик`}</Button>
                    </Stack>
                  </Alert>
                ))}
                {restore.isError && (
                  <Alert color="red">{t`Не удалось открыть сохранённое предложение.`}</Alert>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
