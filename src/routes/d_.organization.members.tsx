import { useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Container,
  Fieldset,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { createFileRoute, Link } from "@tanstack/react-router";

import { useOrganizationMembers } from "@/src/lib/use-organization-members";
import { failureDetails } from "@/src/observability/events";

export const Route = createFileRoute("/d_/organization/members")({
  component: OrganizationMembers,
});
function OrganizationMembers() {
  const { t, i18n } = useLingui();
  const {
    userId,
    isAuthenticated,
    isLoading,
    online,
    current,
    profile,
    organizations,
    organizationRows,
    selection,
    administrative,
    organizationId,
    owned,
    members,
    pending,
    audit,
    ownRows,
    memberRows,
    pendingRows,
    auditRows,
    requestForm,
    reviewForm,
    changeForm,
    request,
    withdraw,
    review,
    change,
    refresh,
    startRequest,
    startReview,
    startChange,
  } = useOrganizationMembers();
  const operations = [request, withdraw, review, change].filter(
    (operation) => operation.variables?.actorId === userId,
  );
  const busy = operations.some((operation) => operation.isPending);
  const roles = {
    doctor: t`Врач`,
    researcher: t`Исследователь`,
    admin: t`Администратор организации`,
  };
  const statuses = {
    pending: t`Ожидает рассмотрения`,
    approved: t`Одобрена`,
    rejected: t`Отклонена`,
    withdrawn: t`Отозвана заявителем`,
  };
  const actions = {
    requested: t`Заявка подана`,
    withdrawn: t`Заявка отозвана`,
    approved: t`Доступ одобрен`,
    rejected: t`Заявка отклонена`,
    changed: t`Права изменены`,
  };
  const errors = {
    PROFESSIONAL_VERIFICATION_REQUIRED: t`Нужно независимое подтверждение квалификации; выбранная клиническая роль должна соответствовать профессии.`,
    REVISION_CONFLICT: t`Состояние изменилось. Обновите список и откройте актуальную запись; введённые значения сохранены.`,
    MEMBERSHIP_CHANGED: t`Членство изменилось после подачи заявки. Заявку нужно пересмотреть; автоматическая выдача прав остановлена.`,
    SELF_MEMBERSHIP_CHANGE_DENIED: t`Собственные административные права изменяет другой администратор.`,
    LAST_ORGANIZATION_ADMIN: t`Нельзя удалить последнего администратора организации.`,
    MEMBERSHIP_REQUEST_CLOSED: t`Заявка уже рассмотрена или отозвана. Обновите список.`,
    MEMBERSHIP_REQUEST_PENDING: t`Заявка уже ожидает рассмотрения.`,
    ALREADY_MEMBER: t`Действующее подтверждённое членство уже существует.`,
    IDEMPOTENCY_KEY_REUSED: t`Этот запрос уже обработан с другими значениями. Обновите состояние перед новой попыткой.`,
  };
  const activeErrors = operations
    .filter((operation) => operation.isError)
    .map((operation) => failureDetails(operation.error).code);
  return (
    <Container component="main" py="md">
      <Stack>
        <Anchor component={Link} to="/d/profile">{t`Мой профиль`}</Anchor>
        <Title>{t`Сотрудники и доступ организации`}</Title>
        <Text>{t`Подайте заявку на вступление в организацию. Подтверждённые администраторы рассматривают заявки и управляют ролями сотрудников.`}</Text>
        <Alert>{t`Выдача и отзыв прав требуют связи с сервером. Права не выдаются локально и не считаются изменёнными до ответа Convex. Медицинские карты на этой странице не отображаются.`}</Alert>
        {isLoading && <Text>{t`Проверяем сессию…`}</Text>}
        {!isLoading && !isAuthenticated && (
          <Anchor
            component={Link}
            to="/d/profile"
          >{t`Войдите через Google и откройте профиль`}</Anchor>
        )}
        {!online && (
          <Alert color="yellow">{t`Без сети управление правами недоступно. Сохранённые клинические пространства работают по ранее выданному сроку доступа; серверный отзыв будет проверен после подключения.`}</Alert>
        )}
        {[profile, organizations, owned, members, pending, audit].some(
          (query) => query.isError,
        ) && (
          <Alert color="red">{t`Не удалось получить актуальные сведения о доступе. Проверьте сеть и административные полномочия.`}</Alert>
        )}
        {activeErrors.map((code, index) => (
          <Alert color="red" key={index}>
            {code in errors
              ? errors[code as keyof typeof errors]
              : t`Операция не подтверждена. Проверьте актуальное состояние перед повтором; форма сохранена.`}
          </Alert>
        ))}
        {operations.some((operation) => operation.isSuccess) && (
          <Alert color="green">{t`Сервер подтвердил операцию. Обновляется актуальное состояние доступа.`}</Alert>
        )}
        {busy && (
          <Text>{t`Ожидаем подтверждение сервера. При обрыве связи операция может завершиться после подключения; не создавайте повторную заявку.`}</Text>
        )}
        {current && (
          <>
            <Button
              variant="default"
              disabled={busy}
              onClick={() => void refresh()}
            >{t`Обновить сведения о доступе`}</Button>
            <Title order={2}>{t`Мои организации`}</Title>
            {current.memberships.map((row) => (
              <Paper withBorder p="md" key={row._id}>
                <Text>
                  {row.organization?.name} — {roles[row.role]}
                </Text>
              </Paper>
            ))}
            <Text>{t`Подтверждение квалификации выполняется отдельно. Заявка и самостоятельный выбор профессии не дают доступа к пациентам.`}</Text>
            {!current.profile?.verified && (
              <Alert>{t`Сначала заполните профиль и получите подтверждение квалификации. Администратор организации не может подтвердить её этой формой.`}</Alert>
            )}
            <TextInput
              label={t`Поиск организации по названию`}
              maxLength={100}
              {...selection.getInputProps("organizationSearch")}
            />
            {organizations.isPending && <Text>{t`Загружаем организации…`}</Text>}
            {organizations.isSuccess && organizationRows.length === 0 && (
              <Text>{t`Организации не найдены. Уточните название.`}</Text>
            )}
            <NativeSelect
              label={t`Организация для вступления`}
              value={requestForm.values.actorId === userId ? requestForm.values.organizationId : ""}
              disabled={busy || !current.profile?.verified}
              data={[
                { value: "", label: t`Выберите организацию` },
                ...organizationRows.map((row) => ({
                  value: row.id,
                  label: `${row.name} — ${row.country} ${row.city}`,
                })),
                ...(requestForm.values.actorId === userId &&
                requestForm.values.organizationId &&
                !organizationRows.some((row) => row.id === requestForm.values.organizationId)
                  ? [
                      {
                        value: requestForm.values.organizationId,
                        label: requestForm.values.organizationName,
                      },
                    ]
                  : []),
              ]}
              onChange={(event) => {
                const id = event.currentTarget.value;
                const row = organizationRows.find((row) => row.id === id);
                const begin = () => startRequest(id, row?.requestRevision ?? 0, row?.name ?? "");
                if (requestForm.values.message.trim())
                  modals.openConfirmModal({
                    title: t`Заменить несохранённую заявку?`,
                    children: (
                      <Text>{t`Введённое обоснование будет заменено. Отправленные заявки останутся доступными.`}</Text>
                    ),
                    labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                    onConfirm: begin,
                  });
                else begin();
              }}
            />
            {organizations.hasNextPage && (
              <Button
                variant="default"
                loading={organizations.isFetchingNextPage}
                onClick={() => void organizations.fetchNextPage()}
              >{t`Загрузить ещё организации`}</Button>
            )}
            {requestForm.values.actorId === userId && requestForm.values.organizationId && (
              <Paper withBorder p="md">
                <form onSubmit={requestForm.onSubmit((input) => request.mutate(input))}>
                  <Fieldset disabled={busy}>
                    <Stack>
                      <Title order={3}>{requestForm.values.organizationName}</Title>
                      <NativeSelect
                        label={t`Запрашиваемая роль`}
                        data={[
                          { value: "doctor", label: roles.doctor },
                          { value: "researcher", label: roles.researcher },
                        ]}
                        {...requestForm.getInputProps("role")}
                      />
                      <Textarea
                        label={t`Основание для вступления, без медицинских данных`}
                        required
                        maxLength={2000}
                        {...requestForm.getInputProps("message")}
                      />
                      <Button type="submit">{t`Подать заявку`}</Button>
                      <Button
                        variant="default"
                        onClick={() => requestForm.reset()}
                      >{t`Отмена`}</Button>
                    </Stack>
                  </Fieldset>
                </form>
              </Paper>
            )}
            <Title order={2}>{t`Мои заявки`}</Title>
            {owned.isPending && <Text>{t`Загружаем заявки…`}</Text>}
            {owned.isSuccess && ownRows.length === 0 && <Text>{t`Заявок пока нет.`}</Text>}
            {ownRows.map((row) => (
              <Paper withBorder p="md" key={row._id}>
                <Stack>
                  <Text>
                    {row.organizationName} — {roles[row.role]}
                  </Text>
                  <Badge>{statuses[row.status]}</Badge>
                  <Text>{row.message}</Text>
                  <Text>{row.reason}</Text>
                  <Text>
                    {t`Версия:`} {row.revision} —{" "}
                    {i18n.date(new Date(row.updatedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Text>
                  {row.status === "pending" ? (
                    <Button
                      variant="default"
                      disabled={busy}
                      onClick={() =>
                        modals.openConfirmModal({
                          title: t`Отозвать заявку на вступление?`,
                          children: <Text>{row.organizationName}</Text>,
                          labels: { confirm: t`Отозвать`, cancel: t`Отмена` },
                          onConfirm: () =>
                            withdraw.mutate({
                              actorId: userId!,
                              requestId: row._id,
                              expectedRevision: row.revision,
                              idempotencyKey: crypto.randomUUID(),
                            }),
                        })
                      }
                    >{t`Отозвать заявку`}</Button>
                  ) : (
                    <Button
                      variant="default"
                      disabled={busy || !current.profile?.verified}
                      onClick={() => {
                        const begin = () =>
                          startRequest(row.organizationId, row.revision, row.organizationName);
                        if (requestForm.values.message.trim())
                          modals.openConfirmModal({
                            title: t`Заменить несохранённую заявку?`,
                            children: (
                              <Text>{t`Введённое обоснование будет заменено. Отправленные заявки останутся доступными.`}</Text>
                            ),
                            labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                            onConfirm: begin,
                          });
                        else begin();
                      }}
                    >{t`Подать новую заявку после рассмотрения`}</Button>
                  )}
                </Stack>
              </Paper>
            ))}
            {owned.hasNextPage && (
              <Button
                variant="default"
                loading={owned.isFetchingNextPage}
                onClick={() => void owned.fetchNextPage()}
              >{t`Загрузить ещё заявки`}</Button>
            )}
            <Title order={2}>{t`Администрирование организации`}</Title>
            <Text>{t`Администратор управляет членством, но его роль не предоставляет доступ к медицинским картам. Первый администратор назначается доверенным оператором платформы.`}</Text>
            <NativeSelect
              label={t`Управляемая организация`}
              disabled={busy}
              data={[
                { value: "", label: t`Выберите организацию` },
                ...administrative.map((row) => ({
                  value: row.organizationId,
                  label: row.organization?.name ?? row.organizationId,
                })),
              ]}
              {...selection.getInputProps("organizationId")}
            />
            {organizationId && (
              <>
                <Title order={3}>{t`Ожидают решения`}</Title>
                {pending.isPending && <Text>{t`Загружаем заявки…`}</Text>}
                {pending.isSuccess && pendingRows.length === 0 && (
                  <Text>{t`Нет заявок, ожидающих решения.`}</Text>
                )}
                {pendingRows.map((row) => (
                  <Paper key={row._id} withBorder p="md">
                    <Stack>
                      <Text>
                        {row.displayName} — {roles[row.role]}
                      </Text>
                      <Text>{row.message}</Text>
                      <Text>
                        {row.qualificationVerified
                          ? t`Квалификация подтверждена`
                          : t`Требуется подтверждение квалификации`}
                      </Text>
                      <Group>
                        <Button
                          disabled={busy || !row.qualificationVerified || row.userId === userId}
                          onClick={() => {
                            const begin = () => startReview(row, true);
                            if (reviewForm.values.reason.trim())
                              modals.openConfirmModal({
                                title: t`Заменить несохранённое решение?`,
                                children: (
                                  <Text>{t`Введённое основание решения будет заменено.`}</Text>
                                ),
                                labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                onConfirm: begin,
                              });
                            else begin();
                          }}
                        >{t`Рассмотреть одобрение`}</Button>
                        <Button
                          variant="default"
                          disabled={busy || row.userId === userId}
                          onClick={() => {
                            const begin = () => startReview(row, false);
                            if (reviewForm.values.reason.trim())
                              modals.openConfirmModal({
                                title: t`Заменить несохранённое решение?`,
                                children: (
                                  <Text>{t`Введённое основание решения будет заменено.`}</Text>
                                ),
                                labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                                onConfirm: begin,
                              });
                            else begin();
                          }}
                        >{t`Рассмотреть отказ`}</Button>
                      </Group>
                    </Stack>
                  </Paper>
                ))}
                {pending.hasNextPage && (
                  <Button
                    variant="default"
                    loading={pending.isFetchingNextPage}
                    onClick={() => void pending.fetchNextPage()}
                  >{t`Загрузить ещё заявки`}</Button>
                )}
                {reviewForm.values.requestId &&
                  reviewForm.values.actorId === userId &&
                  reviewForm.values.organizationId === organizationId && (
                    <Paper withBorder p="md">
                      <form
                        onSubmit={reviewForm.onSubmit(
                          (input) =>
                            void modals.openConfirmModal({
                              title: input.approved
                                ? t`Подтвердить членство и выдать запрошенную роль?`
                                : t`Отклонить заявку?`,
                              children: (
                                <Stack>
                                  <Text>
                                    {input.targetName} — {roles[input.requestedRole]}
                                  </Text>
                                  <Text>{input.reason}</Text>
                                  <Text>{t`Роль врача открывает CRUD карт своей организации; роль исследователя — только явно разрешённое чтение.`}</Text>
                                </Stack>
                              ),
                              labels: { confirm: t`Подтвердить`, cancel: t`Отмена` },
                              onConfirm: () => review.mutate(input),
                            }),
                        )}
                      >
                        <Fieldset disabled={busy}>
                          <Stack>
                            <Title order={3}>
                              {reviewForm.values.approved
                                ? t`Одобрение заявки`
                                : t`Отказ по заявке`}
                            </Title>
                            <Text>
                              {reviewForm.values.targetName} —{" "}
                              {roles[reviewForm.values.requestedRole]}
                            </Text>
                            <Textarea
                              label={t`Основание решения, без медицинских данных`}
                              required
                              maxLength={1000}
                              {...reviewForm.getInputProps("reason")}
                            />
                            <Button type="submit">{t`Проверить и подтвердить решение`}</Button>
                            <Button
                              variant="default"
                              onClick={() => reviewForm.reset()}
                            >{t`Отмена`}</Button>
                          </Stack>
                        </Fieldset>
                      </form>
                    </Paper>
                  )}
                <Title order={3}>{t`Сотрудники организации`}</Title>
                {members.isPending && <Text>{t`Загружаем сотрудников…`}</Text>}
                {memberRows.map((row) => (
                  <Paper key={row.id} withBorder p="md">
                    <Stack>
                      <Text>
                        {row.displayName} — {roles[row.role]}
                      </Text>
                      <Badge>
                        {row.active && row.verified
                          ? t`Доступ действует`
                          : t`Доступ отключён или не подтверждён`}
                      </Badge>
                      <Text>
                        {t`Версия:`} {row.revision}
                      </Text>
                      <Button
                        variant="default"
                        disabled={busy || row.userId === userId}
                        onClick={() => {
                          const begin = () => startChange(row);
                          if (changeForm.values.reason.trim())
                            modals.openConfirmModal({
                              title: t`Заменить несохранённое решение?`,
                              children: (
                                <Text>{t`Введённое основание решения будет заменено.`}</Text>
                              ),
                              labels: { confirm: t`Продолжить`, cancel: t`Отмена` },
                              onConfirm: begin,
                            });
                          else begin();
                        }}
                      >{t`Изменить роль или доступ`}</Button>
                    </Stack>
                  </Paper>
                ))}
                {members.hasNextPage && (
                  <Button
                    variant="default"
                    loading={members.isFetchingNextPage}
                    onClick={() => void members.fetchNextPage()}
                  >{t`Загрузить ещё сотрудников`}</Button>
                )}
                {changeForm.values.membershipId &&
                  changeForm.values.actorId === userId &&
                  changeForm.values.organizationId === organizationId && (
                    <Paper withBorder p="md">
                      <form
                        onSubmit={changeForm.onSubmit(
                          (input) =>
                            void modals.openConfirmModal({
                              title: t`Изменить права сотрудника?`,
                              children: (
                                <Stack>
                                  <Text>{input.targetName}</Text>
                                  <Text>
                                    {roles[input.role]} —{" "}
                                    {input.active ? t`Доступ действует` : t`Доступ будет отключён`}
                                  </Text>
                                  <Text>{input.reason}</Text>
                                  <Text>{t`Изменение проверяется сервером. Отзыв не может немедленно удалить уже выданные офлайн-копии на недоступном устройстве.`}</Text>
                                </Stack>
                              ),
                              labels: { confirm: t`Подтвердить`, cancel: t`Отмена` },
                              onConfirm: () => change.mutate(input),
                            }),
                        )}
                      >
                        <Fieldset disabled={busy}>
                          <Stack>
                            <Title order={3}>{t`Изменение членства`}</Title>
                            <Text>{changeForm.values.targetName}</Text>
                            <NativeSelect
                              label={t`Роль сотрудника`}
                              data={Object.entries(roles).map(([value, label]) => ({
                                value,
                                label,
                              }))}
                              {...changeForm.getInputProps("role")}
                            />
                            <Checkbox
                              label={t`Активный доступ к организации`}
                              {...changeForm.getInputProps("active", { type: "checkbox" })}
                            />
                            <Textarea
                              label={t`Основание изменения, без медицинских данных`}
                              required
                              maxLength={1000}
                              {...changeForm.getInputProps("reason")}
                            />
                            <Button type="submit">{t`Проверить и подтвердить изменение`}</Button>
                            <Button
                              variant="default"
                              onClick={() => changeForm.reset()}
                            >{t`Отмена`}</Button>
                          </Stack>
                        </Fieldset>
                      </form>
                    </Paper>
                  )}
                <Title order={3}>{t`Журнал доступа`}</Title>
                <Text>{t`Журнал показывает время, участников, изменения прав и основания решений. Тексты заявок и поля медицинских карт в события журнала не копируются.`}</Text>
                {audit.isSuccess && auditRows.length === 0 && (
                  <Text>{t`Событий управления доступом пока нет.`}</Text>
                )}
                <Table.ScrollContainer minWidth={700}>
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t`Время`}</Table.Th>
                        <Table.Th>{t`Действие`}</Table.Th>
                        <Table.Th>{t`Кто изменил`}</Table.Th>
                        <Table.Th>{t`Сотрудник`}</Table.Th>
                        <Table.Th>{t`Роль и доступ`}</Table.Th>
                        <Table.Th>{t`Основание решения`}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {auditRows.map((row) => (
                        <Table.Tr key={row._id}>
                          <Table.Td>
                            {i18n.date(new Date(row.at), {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </Table.Td>
                          <Table.Td>{actions[row.action]}</Table.Td>
                          <Table.Td>{row.actorId}</Table.Td>
                          <Table.Td>{row.targetUserId}</Table.Td>
                          <Table.Td>
                            {row.previousRole ? roles[row.previousRole] : "—"} →{" "}
                            {roles[row.nextRole]} / {row.previousActive ? t`Да` : t`Нет`} →{" "}
                            {row.nextActive ? t`Да` : t`Нет`}
                          </Table.Td>
                          <Table.Td>{row.reason}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                {audit.hasNextPage && (
                  <Button
                    variant="default"
                    loading={audit.isFetchingNextPage}
                    onClick={() => void audit.fetchNextPage()}
                  >{t`Загрузить ещё события`}</Button>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Container>
  );
}
