import { z } from "zod";

import { createActionRegistry, cureActions } from "@/src/lib/action-registry";
import type { ActionContext } from "@/src/lib/action-registry";
import type { WebMcpTool } from "@/src/lib/webmcp";

const descriptions: Record<string, string> = {
  "patients.overview":
    "Общие агрегированные показатели доступных записей рабочего пространства: число записей, распределение по полу и полнота данных. Без идентификаторов пациентов.",
  "cohort.summarize":
    "Описательная сводка когорты по критериям отбора (коды диагнозов включения и исключения, совпадение any/all, пол): схема отбора, распределение по полу и кодам диагнозов. Агрегаты без идентификаторов.",
  "cohort.compare":
    "Бинарное сравнение двух когорт: доли исхода с точными интервалами Клоппера — Пирсона и критерий χ² с поправкой Йейтса при выполнении условий. Агрегаты без идентификаторов.",
  "observations.codes":
    "Список кодов числовых наблюдений, доступных в выбранной когорте. Доступно только врачу.",
  "analyses.list":
    "Список собственных сохранённых определений анализов текущего пользователя: названия, описания и время обновления, без критериев и без данных пациентов.",
};

// WebMCP tool names avoid dots to stay within common agent name patterns.
export function webmcpToolName(actionId: string) {
  return actionId.replaceAll(".", "_");
}

// Read actions only: write and destructive actions require the in-page
// confirmation flow and stay unavailable to browser agents for now.
export function buildWebMcpTools(
  getContext: () => ActionContext,
  actor: { userId: string },
  registry: ReturnType<typeof createActionRegistry> = createActionRegistry(),
): WebMcpTool[] {
  return registry
    .list()
    .filter(({ kind }) => kind === "read")
    .map(({ id }) => {
      const action = cureActions.find((candidate) => candidate.id === id)!;
      return {
        name: webmcpToolName(id),
        description: descriptions[id] ?? id,
        inputSchema: z.toJSONSchema(action.input) as Record<string, unknown>,
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: (input: unknown) =>
          registry.run(
            getContext(),
            { kind: "assistant", interface: "webmcp", userId: actor.userId },
            id,
            input,
          ),
      };
    });
}
