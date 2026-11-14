import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { calculateStudyScores, visibleStudyFields } from "@/src/lib/study-form-model";

// Presentation data only: route files retain their own JSX and Mantine controls.
export function clinicalHistoryContent(
  payload: ClinicalPayload,
  i18n: I18n,
  names: Map<string, string>,
) {
  const _ = i18n._.bind(i18n);
  const kinds = {
    history: msg`Анамнез`,
    allergy: msg`Аллергия`,
    medication: msg`Лекарственная терапия`,
    observation: msg`Результат обследования`,
    visit: msg`Клинический визит`,
    questionnaire: msg`Опросник`,
    enrollment: msg`Участие в исследовании`,
    studyVisit: msg`Визит исследования`,
    studyIssue: msg`Безопасность исследования`,
  };
  const codes = {
    consultation: msg`Консультация`,
    procedure: msg`Процедура`,
    followUp: msg`Повторный приём`,
    unknown: msg`Неизвестно`,
    mild: msg`Лёгкая`,
    moderate: msg`Умеренная`,
    severe: msg`Тяжёлая`,
    active: msg`Активно`,
    inactive: msg`Неактивно`,
    completed: msg`Завершено`,
    stopped: msg`Прекращено`,
    planned: msg`Запланирован`,
    inProgress: msg`Выполняется`,
    cancelled: msg`Отменено`,
    noShow: msg`Неявка`,
    draft: msg`Черновик`,
    final: msg`Окончательный ответ`,
    screening: msg`Скрининг`,
    ineligible: msg`Не соответствует критериям`,
    enrolled: msg`Включён`,
    declined: msg`Отказ`,
    withdrawn: msg`Выбыл`,
    open: msg`Открыто`,
    underReview: msg`На рассмотрении`,
    resolved: msg`Рассмотрено`,
    closed: msg`Закрыто`,
    death: msg`Смерть`,
    lifeThreatening: msg`Угроза жизни в момент события`,
    hospitalization: msg`Госпитализация или её продление`,
    disability: msg`Стойкая или значительная нетрудоспособность`,
    congenitalAnomaly: msg`Врождённая аномалия`,
    medicallyImportant: msg`Другое медицински значимое событие`,
    unassessed: msg`Не оценена`,
    unrelated: msg`Связь отсутствует`,
    possible: msg`Возможная связь`,
    probable: msg`Вероятная связь`,
    related: msg`Связь установлена врачом`,
    expected: msg`Ожидаемое`,
    unexpected: msg`Неожиданное`,
    ongoing: msg`Продолжается`,
    recovering: msg`Улучшение`,
    recovered: msg`Выздоровление`,
    sequelae: msg`Выздоровление с последствиями`,
    fatal: msg`Летальный исход`,
    minor: msg`Незначительное`,
    major: msg`Значительное`,
    critical: msg`Критическое`,
    adverseEvent: msg`Нежелательное явление`,
    deviation: msg`Отклонение от протокола`,
  };
  const code = (value: string) => (value in codes ? _(codes[value as keyof typeof codes]) : value);
  const boolean = (value: boolean) => (value ? _(msg`Да`) : _(msg`Нет`));
  const date = (value: string) =>
    value
      ? i18n.date(new Date(`${value}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" })
      : "—";
  const rows: [string, string][] = [
    [_(msg`Дата записи (UTC)`), date(payload.occurredOn)],
    [_(msg`Примечания`), payload.notes],
  ];
  const add = (label: MessageDescriptor, value: string) => rows.push([_(label), value || "—"]);
  if (payload.kind === "history") add(msg`Анамнез`, payload.text);
  if (payload.kind === "allergy") {
    add(msg`Вещество`, payload.substance);
    add(msg`Реакция`, payload.reaction);
    add(msg`Тяжесть`, code(payload.severity));
    add(msg`Статус`, code(payload.status));
  }
  if (payload.kind === "medication") {
    add(msg`Препарат`, payload.drug);
    add(msg`Код`, payload.code);
    add(msg`Дозировка`, payload.dosage);
    add(msg`Путь введения`, payload.route);
    add(msg`Дата завершения`, date(payload.endedOn));
    add(msg`Статус`, code(payload.status));
  }
  if (payload.kind === "observation") {
    add(msg`Показатель`, payload.name);
    add(msg`Код`, payload.code);
    add(
      msg`Результат`,
      payload.numericValue === null
        ? payload.textValue
        : `${i18n.number(payload.numericValue)} ${payload.unit}`,
    );
  }
  if (payload.kind === "visit" || payload.kind === "studyVisit") {
    add(msg`Запланированное время`, payload.scheduledFor);
    add(msg`Продолжительность, минуты`, i18n.number(payload.durationMinutes));
    add(
      msg`Тип визита`,
      payload.visitType === "hospitalization" ? _(msg`Госпитализация`) : code(payload.visitType),
    );
    add(msg`Статус`, code(payload.status));
    add(msg`Цель визита`, payload.reason);
    add(msg`Место`, payload.location);
    add(msg`Результат визита`, payload.outcome);
    add(msg`Следующее наблюдение`, date(payload.followUpOn));
    add(msg`Причина отмены`, payload.cancellationReason);
    if (payload.kind === "studyVisit") {
      add(msg`Версия протокола`, i18n.number(payload.protocolVersion));
      add(msg`Окно визита (UTC)`, `${date(payload.windowFrom)} — ${date(payload.windowTo)}`);
      add(msg`Фактическая дата проведения (UTC)`, date(payload.performedOn));
      add(msg`Обоснование отклонения от окна визита`, payload.deviationReason);
      add(msg`Причина исправления`, payload.amendmentReason);
    }
  }
  if (payload.kind === "questionnaire") {
    add(msg`Шаблон`, payload.definition.title);
    add(msg`Версия шаблона:`, i18n.number(payload.formVersion));
    add(msg`Статус`, code(payload.status));
    add(msg`Причина исправления`, payload.amendmentReason);
    const visible = visibleStudyFields(payload.definition, payload.answers);
    for (const field of payload.definition.fields.filter((row) => visible.has(row.id))) {
      const value = payload.answers[field.id];
      const option = (value: string) =>
        field.type === "choice" || field.type === "multiChoice"
          ? (field.choices.find((row) => row.value === value)?.label ?? value)
          : value;
      rows.push([
        field.label,
        value === undefined
          ? _(msg`Ответ не указан`)
          : typeof value === "boolean"
            ? boolean(value)
            : typeof value === "number"
              ? `${i18n.number(value)} ${field.type === "number" ? field.unit : ""}`
              : Array.isArray(value)
                ? value.map(option).join(", ")
                : field.type === "date"
                  ? date(value)
                  : option(value),
      ]);
    }
    for (const result of calculateStudyScores(payload.definition, payload.answers))
      rows.push([
        result.score.label,
        result.status === "calculated"
          ? `${i18n.number(result.value, { maximumFractionDigits: 6 })} ${result.score.unit}`
          : result.status === "incomplete"
            ? _(msg`Недостаточно ответов для расчёта`)
            : result.status === "notApplicable"
              ? _(msg`Шкала не применима к активной ветке`)
              : _(msg`Некорректные исходные значения`),
      ]);
  }
  if (payload.kind === "enrollment") {
    add(msg`Версия протокола`, i18n.number(payload.protocolVersion));
    for (const event of payload.events) {
      rows.push([`${date(event.occurredOn)} — ${code(event.status)}`, event.reason]);
      add(msg`Автор решения`, names.get(event.recordedBy) ?? event.recordedBy);
      add(msg`Обоснование соответствия критериям`, event.eligibilityEvidence);
      add(msg`Критерии включения подтверждены`, boolean(event.inclusionConfirmed));
      add(msg`Критерии исключения отсутствуют`, boolean(event.exclusionAbsent));
      if (event.consent) {
        add(msg`Документ согласия`, event.consent.documentReference);
        add(msg`Версия согласия`, event.consent.version);
        add(msg`Дата подписания`, date(event.consent.signedOn));
        add(msg`Согласие действует до`, date(event.consent.expiresOn));
      }
    }
  }
  if (payload.kind === "studyIssue") {
    add(msg`Краткое название события`, payload.title);
    add(msg`Описание события`, payload.description);
    add(msg`Дата обнаружения (UTC)`, date(payload.detectedOn));
    add(msg`Статус рассмотрения`, code(payload.status));
    add(
      msg`Ответственный врач за рассмотрение`,
      names.get(payload.reviewerId) ?? payload.reviewerId,
    );
    add(msg`Срок рассмотрения (UTC)`, date(payload.reviewDueOn));
    add(msg`Заключение и решение`, payload.resolution);
    add(msg`Дата рассмотрения (UTC)`, date(payload.reviewedOn));
    add(msg`Автор решения`, names.get(payload.reviewedBy) ?? payload.reviewedBy);
    add(msg`Причина исправления`, payload.amendmentReason);
    add(msg`Версия протокола`, i18n.number(payload.protocolVersion));
    const details = payload.details;
    add(msg`Вид события`, code(details.type));
    if (details.type === "adverseEvent") {
      add(msg`Тяжесть симптомов`, code(details.severity));
      add(msg`Критерии серьёзности`, details.seriousness.map(code).join(", "));
      add(msg`Причинная связь с исследуемым воздействием`, code(details.causality));
      add(msg`Ожидаемость`, code(details.expectedness));
      add(msg`Подозреваемый препарат или воздействие`, details.suspectAgent);
      add(msg`Предпринятые действия`, details.actionTaken);
      add(msg`Исход явления`, code(details.outcome));
      add(msg`Дата исхода (UTC)`, date(details.endedOn));
    } else {
      add(msg`Значимость отклонения`, code(details.impact));
      add(msg`Раздел или требование протокола`, details.protocolSection);
      add(msg`Коренная причина`, details.rootCause);
      add(msg`Корректирующие действия или обоснование их отсутствия`, details.correctiveAction);
      add(msg`Предупреждающие действия или обоснование их отсутствия`, details.preventiveAction);
    }
  }
  return { title: _(kinds[payload.kind]), rows };
}
