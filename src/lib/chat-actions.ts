import { z } from "zod";

import { createActionRegistry } from "@/src/lib/action-registry";

export const assistantActionPayloadSchema = z.object({
  action: z.string().min(1).max(100),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type AssistantActionPayload = z.infer<typeof assistantActionPayloadSchema>;

// Tolerant extraction of the protocol JSON: strict body, fenced block or
// the outermost braces. Ordinary prose is not an action request.
export function parseAssistantAction(text: string): AssistantActionPayload | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = assistantActionPayloadSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

// Compact action catalogue for the prompt: id, kind, description, schema.
export function actionCatalogue(registry: ReturnType<typeof createActionRegistry>) {
  return registry.list().map(({ id, kind, destructive, description }) => ({
    id,
    kind,
    destructive,
    description,
  }));
}

// The wire contract deliberately carries only user/assistant messages, so
// the protocol travels as a prefix of the latest user message. Models see
// the same catalogue the registry enforces; hallucinated ids and fields
// are rejected later by the registry itself.
export function buildActionProtocolPrefix(
  registry: ReturnType<typeof createActionRegistry>,
  available: boolean,
) {
  if (!available)
    return [
      "Ты — помощник приложения Cure. Отвечай на русском, кратко и по существу.",
      "Рабочее пространство пациентов сейчас закрыто, поэтому действия с данными недоступны. Не предлагай выполнить действие и не отвечай JSON; объясни, что сначала нужно открыть пространство на странице «Аналитика» или «Пациенты».",
    ].join("\n");
  const catalogue = actionCatalogue(registry)
    .map(
      ({ id, kind, destructive, description }) =>
        `- ${id} (${kind === "write" ? "запись" : "чтение"}${destructive ? ", разрушительное" : ""}): ${description}`,
    )
    .join("\n");
  return [
    "Ты — помощник приложения Cure. Отвечай на русском, кратко и по существу.",
    "Если для ответа хватает текста — отвечай обычным текстом без JSON и разметки.",
    'Если пользователь просит данные или операцию из списка действий ниже, ответь ТОЛЬКО одним JSON-объектом вида {"action":"<идентификатор>","input":{...}} без пояснений, markdown и ограждений.',
    "Поле input опускай, если у действия нет параметров. Не выдумывай идентификаторы действий и поля ввода; используй только перечисленные.",
    "Действия записи выполняются только после явного подтверждения пользователя в интерфейсе.",
    "Если запрос нельзя выполнить перечисленными действиями, ответь текстом и коротко назови, что доступно.",
    "Доступные действия:",
    catalogue,
  ].join("\n");
}

// Wraps the latest user message with the protocol; history stays clean.
export function protocolMessages(
  messages: readonly { role: "user" | "assistant"; content: string }[],
  prefix: string,
) {
  if (!messages.length) throw new Error("INVALID_INPUT");
  return messages.map((message, index) =>
    index === messages.length - 1 && message.role === "user"
      ? { ...message, content: `${prefix}\n\nЗапрос пользователя: ${message.content}` }
      : message,
  );
}
