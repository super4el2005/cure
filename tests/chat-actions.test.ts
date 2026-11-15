import { describe, expect, it } from "@rstest/core";

import { createActionRegistry, cureActions } from "@/src/lib/action-registry";
import {
  actionCatalogue,
  buildActionProtocolPrefix,
  parseAssistantAction,
  protocolMessages,
} from "@/src/lib/chat-actions";

const registry = createActionRegistry();

describe("assistant action parsing", () => {
  it("accepts strict, fenced and embedded protocol JSON", () => {
    expect(parseAssistantAction('{"action":"patients.overview","input":{}}')).toEqual({
      action: "patients.overview",
      input: {},
    });
    expect(
      parseAssistantAction('Вот результат:\n```json\n{"action":"analyses.list"}\n```'),
    ).toEqual({ action: "analyses.list", input: {} });
    expect(
      parseAssistantAction(
        'Выполняю: {"action":"cohort.summarize","input":{"criteria":{"include":["A"],"exclude":[],"diagnosisMatch":"any","sex":"any"}}} готово',
      ),
    ).toEqual({
      action: "cohort.summarize",
      input: { criteria: { include: ["A"], exclude: [], diagnosisMatch: "any", sex: "any" } },
    });
  });
  it("rejects prose and malformed payloads", () => {
    expect(parseAssistantAction("Обычный ответ без JSON")).toBe(null);
    expect(parseAssistantAction('{"answer":"text"}')).toBe(null);
    expect(parseAssistantAction('{"action":""}')).toBe(null);
    expect(parseAssistantAction('{"action":"x","input":"not-an-object"}')).toBe(null);
    expect(parseAssistantAction("{not json}")).toBe(null);
  });
});
describe("action protocol prompt", () => {
  it("lists every registry action with kind and description", () => {
    const prefix = buildActionProtocolPrefix(registry, true);
    for (const { id } of registry.list()) expect(prefix).toContain(id);
    expect(prefix).toContain("запись");
    expect(prefix).toContain("подтверждения");
    expect(prefix).not.toMatch(/Private|1990/);
    expect(
      actionCatalogue(registry)
        .map(({ id }) => id)
        .sort(),
    ).toEqual([...cureActions.map(({ id }) => id)].sort());
  });
  it("forbids actions when the workspace is closed", () => {
    const prefix = buildActionProtocolPrefix(registry, false);
    expect(prefix).toContain("закрыто");
    expect(prefix).not.toContain("patients.overview");
  });
  it("wraps only the latest user message", () => {
    const messages = [
      { role: "user" as const, content: "Первый" },
      { role: "assistant" as const, content: "Ответ" },
      { role: "user" as const, content: "Второй" },
    ];
    const wrapped = protocolMessages(messages, "PREFIX");
    expect(wrapped[0]).toEqual(messages[0]);
    expect(wrapped[1]).toEqual(messages[1]);
    expect(wrapped[2]!.content).toBe("PREFIX\n\nЗапрос пользователя: Второй");
    expect(() => protocolMessages([], "PREFIX")).toThrow("INVALID_INPUT");
  });
});
