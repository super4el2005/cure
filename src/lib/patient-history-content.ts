import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { PatientVersion } from "@/src/lib/patient-version-model";

export function patientHistoryContent(
  values: PatientVersion["values"],
  i18n: I18n,
  names: Map<string, string>,
) {
  const _ = i18n._.bind(i18n);
  const date = (value: string) =>
    value && Number.isFinite(Date.parse(value))
      ? i18n.date(new Date(value), { dateStyle: "medium", timeZone: "UTC" })
      : value || "—";
  const timestamp = (value: number) =>
    i18n.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  const rows: [string, string][] = [
    [_(msg`Имя пациента`), values.fullName],
    [_(msg`Дата рождения`), date(values.birthDate)],
    [
      _(msg`Пол`),
      values.sex === "female"
        ? _(msg`Женский`)
        : values.sex === "male"
          ? _(msg`Мужской`)
          : _(msg`Неизвестно`),
    ],
    [_(msg`Диагнозы`), values.diagnosisCodes.join(", ") || "—"],
    [_(msg`Заметки`), values.notes || "—"],
  ];
  for (const event of values.consentHistory) {
    rows.push(
      [
        `${_(msg`Версия согласия`)} ${event.version}`,
        event.kind === "granted" ? _(msg`Согласие зафиксировано`) : _(msg`Отзыв зафиксирован`),
      ],
      [_(msg`Цель использования данных`), event.purpose],
      [_(msg`Получатели`), event.recipients.map((id) => names.get(id) ?? id).join(", ")],
      [
        _(msg`Состав данных`),
        event.scope.map((value) => (value === "sex" ? _(msg`Пол`) : _(msg`Диагнозы`))).join(", "),
      ],
      [_(msg`Документ согласия`), event.documentReference],
      [_(msg`Срок, указанный в событии`), timestamp(event.expiresAt)],
      [_(msg`Время фиксации`), timestamp(event.recordedAt)],
      [_(msg`Автор решения`), names.get(event.recordedBy) ?? event.recordedBy],
    );
  }
  return rows;
}
