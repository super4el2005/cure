import { z } from "zod";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import { analyzeCohort, cohortCriteriaSchema } from "@/src/lib/cohort-analysis";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { compareCohorts } from "@/src/lib/cohort-comparison";
import { cohortComparisonSchema } from "@/src/lib/cohort-comparison-model";
import { availableObservationCodes, cohortMemberIds } from "@/src/lib/cohort-statistics";
import type { PatientRow } from "@/src/lib/patient-model";
import type { openPatientWorkspace } from "@/src/lib/patient-workspace";
import { analysisValuesSchema } from "@/src/lib/saved-analysis-model";
import type { SavedAnalysis } from "@/src/lib/saved-analysis-model";

export type WorkspaceHandle = Awaited<ReturnType<typeof openPatientWorkspace>>;

export const actionActorSchema = z.object({
  kind: z.enum(["user", "assistant"]),
  interface: z.enum(["ui", "chat", "webmcp"]),
  userId: z.string().min(1).max(200),
  model: z.string().max(200).exactOptional(),
});
export type ActionActor = z.infer<typeof actionActorSchema>;

// Callers prepare decrypted, already-authorized views; actions never decrypt.
export type ActionContext = {
  workspace: WorkspaceHandle | null;
  rows: readonly PatientRow[];
  clinicalRows: readonly ClinicalRecord[];
  analyses: readonly SavedAnalysis[];
  role: "doctor" | "researcher";
  now: number;
  journal?: { record: (entry: ActionJournalEntry) => void };
};

export type ActionJournalEntry = {
  at: number;
  actor: ActionActor;
  action: string;
  version: number;
  ok: boolean;
  error: string | null;
  affected: { kind: string; count: number };
};

export type ActionDefinition<Input, Output> = {
  id: string;
  version: 1;
  kind: "read" | "write";
  roles: readonly ("doctor" | "researcher")[];
  destructive: boolean;
  description: string;
  input: z.ZodType<Input>;
  run: (context: ActionContext, input: Input) => Output | Promise<Output>;
  affected: (output: Output) => { kind: string; count: number };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = ActionDefinition<any, any>;

const aggregate = () => ({ kind: "aggregate", count: 1 });

// Shared read/write surface for the interface, the assistant and WebMCP.
// Every action reuses the same selection, authorization and persistence
// primitives as the corresponding screen; outputs stay aggregate or are
// limited to the caller's own analysis definitions.
export const cureActions = [
  {
    id: "patients.overview",
    version: 1,
    kind: "read",
    roles: ["doctor", "researcher"],
    destructive: false,
    description:
      "Общие агрегированные показатели доступных записей рабочего пространства: число записей, распределение по полу и полнота данных. Без идентификаторов пациентов.",
    input: z.object({}),
    run: (context) => {
      const summary = analyzeCohort(context.rows, context.role, defaultCohortCriteria, context.now);
      return {
        available: summary.flow.available,
        selected: summary.flow.selected,
        sexCounts: summary.sexCounts,
        sexDenominator: summary.sexDenominator,
        diagnosisDenominator: summary.diagnosisDenominator,
      };
    },
    affected: aggregate,
  },
  {
    id: "cohort.summarize",
    version: 1,
    kind: "read",
    roles: ["doctor", "researcher"],
    destructive: false,
    description:
      "Описательная сводка когорты по критериям отбора (коды диагнозов включения и исключения, совпадение any/all, пол): схема отбора, распределение по полу и кодам диагнозов. Агрегаты без идентификаторов.",
    input: z.object({ criteria: cohortCriteriaSchema }),
    run: (context, input) => analyzeCohort(context.rows, context.role, input.criteria, context.now),
    affected: aggregate,
  },
  {
    id: "cohort.compare",
    version: 1,
    kind: "read",
    roles: ["doctor", "researcher"],
    destructive: false,
    description:
      "Бинарное сравнение двух когорт: доли исхода с точными интервалами Клоппера — Пирсона и критерий χ² с поправкой Йейтса при выполнении условий. Агрегаты без идентификаторов.",
    input: z.object({
      criteria: cohortCriteriaSchema,
      comparison: cohortComparisonSchema,
    }),
    run: (context, input) =>
      compareCohorts(context.rows, context.role, input.criteria, input.comparison, context.now),
    affected: aggregate,
  },
  {
    id: "observations.codes",
    version: 1,
    kind: "read",
    roles: ["doctor"],
    destructive: false,
    description:
      "Список кодов числовых наблюдений, доступных в выбранной когорте. Доступно только врачу.",
    input: z.object({ criteria: cohortCriteriaSchema.default(defaultCohortCriteria) }),
    run: (context, input) => ({
      codes: availableObservationCodes(
        context.clinicalRows,
        cohortMemberIds(context.rows, context.role, input.criteria, context.now),
      ),
    }),
    affected: aggregate,
  },
  {
    id: "analyses.list",
    version: 1,
    kind: "read",
    roles: ["doctor", "researcher"],
    destructive: false,
    description:
      "Список собственных сохранённых определений анализов текущего пользователя: названия, описания и время обновления, без критериев и без данных пациентов.",
    input: z.object({}),
    run: (context) => ({
      analyses: context.analyses
        .filter((row) => !row.deleted && row.values)
        .map((row) => ({
          clientId: row.clientId,
          revision: row.revision,
          title: row.values!.title,
          description: row.values!.description,
          updatedAt: row.updatedAt,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }),
    affected: aggregate,
  },
  {
    id: "analysis.save",
    version: 1,
    kind: "write",
    roles: ["doctor", "researcher"],
    destructive: false,
    description:
      "Сохранение собственного определения анализа (название, описание, критерии когорты, настройки сравнения) в зашифрованную офлайн-очередь. Не меняет карты пациентов.",
    input: z.object({
      clientId: z.uuid().default(() => crypto.randomUUID()),
      expectedRevision: z.number().int().min(0).default(0),
      values: analysisValuesSchema,
    }),
    run: async (context, input) => {
      if (!context.workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await context.workspace.saveAnalysis({
        clientId: input.clientId,
        expectedRevision: input.expectedRevision,
        action: input.expectedRevision ? "update" : "create",
        values: input.values,
      });
      return { clientId: input.clientId, transactionId: result.transactionId };
    },
    affected: () => ({ kind: "analysis", count: 1 }),
  },
] satisfies AnyAction[];

export function createActionRegistry(actions: readonly AnyAction[] = cureActions) {
  const map = new Map<string, AnyAction>();
  for (const action of actions) {
    if (map.has(action.id)) throw new Error("DUPLICATE_ACTION");
    map.set(action.id, action);
  }
  return {
    list: () =>
      actions.map(({ id, version, kind, roles, destructive, description }) => ({
        id,
        version,
        kind,
        roles: [...roles],
        destructive,
        description,
      })),
    async run(context: ActionContext, actor: ActionActor, id: string, rawInput: unknown) {
      const action = map.get(id);
      const parsedActor = actionActorSchema.parse(actor);
      if (!action) {
        context.journal?.record({
          at: context.now,
          actor: parsedActor,
          action: id,
          version: 0,
          ok: false,
          error: "UNKNOWN_ACTION",
          affected: { kind: "none", count: 0 },
        });
        throw new Error("UNKNOWN_ACTION");
      }
      const entry = (ok: boolean, error: string | null, affected: ActionJournalEntry["affected"]) =>
        context.journal?.record({
          at: context.now,
          actor: parsedActor,
          action: id,
          version: action.version,
          ok,
          error,
          affected,
        });
      if (!action.roles.includes(context.role)) {
        entry(false, "ACCESS_DENIED", { kind: "none", count: 0 });
        throw new Error("ACCESS_DENIED");
      }
      const parsed = action.input.safeParse(rawInput ?? {});
      if (!parsed.success) {
        entry(false, "INVALID_INPUT", { kind: "none", count: 0 });
        throw new Error("INVALID_INPUT");
      }
      try {
        const output = await action.run(context, parsed.data);
        entry(true, null, action.affected(output));
        return output;
      } catch (error) {
        const code = error instanceof Error ? error.message : "ACTION_FAILED";
        entry(false, code, { kind: "none", count: 0 });
        throw error;
      }
    },
  };
}
