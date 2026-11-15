import { describe, expect, it } from "@rstest/core";

import { createActionJournal } from "@/src/lib/action-journal";
import type { ActionContext } from "@/src/lib/action-registry";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";
import { registerWebMcpTools } from "@/src/lib/webmcp";
import type { ModelContextLike } from "@/src/lib/webmcp";
import { buildWebMcpTools, webmcpToolName } from "@/src/lib/webmcp-actions";

function patient(group: string, extra: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private name",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: [group],
    notes: "Private notes",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...extra,
  });
}
const journal = createActionJournal();
const context: ActionContext = {
  workspace: null,
  rows: [patient("A"), patient("A", { sex: "male" })],
  clinicalRows: [],
  analyses: [],
  role: "doctor",
  now: 50,
  journal,
};

describe("webmcp tool definitions", () => {
  it("exposes only read actions with sanitized names and json schemas", () => {
    const tools = buildWebMcpTools(() => context, { userId: "user-1" });
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "analyses_list",
      "cohort_compare",
      "cohort_summarize",
      "observations_codes",
      "patients_overview",
    ]);
    expect(webmcpToolName("cohort.compare")).toBe("cohort_compare");
    expect(tools.every(({ annotations }) => annotations?.readOnlyHint === true)).toBe(true);
    const overview = tools.find(({ name }) => name === "patients_overview")!;
    expect(overview.inputSchema).toMatchObject({ type: "object" });
    expect(overview.description.length).toBeGreaterThan(20);
    expect(tools.find(({ name }) => name === "analysis_save")).toBeUndefined();
  });
  it("executes through the registry with the webmcp actor and journal", async () => {
    const tools = buildWebMcpTools(() => context, { userId: "user-1" });
    const overview = tools.find(({ name }) => name === "patients_overview")!;
    const output = (await overview.execute({})) as { selected: number };
    expect(output.selected).toBe(2);
    const entries = journal.list().filter((entry) => entry.actor.interface === "webmcp");
    expect(entries.at(-1)).toMatchObject({
      action: "patients.overview",
      ok: true,
      actor: { kind: "assistant", interface: "webmcp", userId: "user-1" },
    });
    expect(JSON.stringify(output)).not.toMatch(/Private|1990/);
    const summarize = tools.find(({ name }) => name === "cohort_summarize")!;
    await expect(summarize.execute({ criteria: { sex: "any" } })).rejects.toThrow("INVALID_INPUT");
  });
});
describe("webmcp registration adapter", () => {
  it("registers tools under an abort signal and reports unsupported hosts", () => {
    const registered: string[] = [];
    const host: ModelContextLike = {
      registerTool: (tool) => {
        registered.push(tool.name);
      },
    };
    const controller = new AbortController();
    const tools = buildWebMcpTools(() => context, { userId: "user-1" });
    expect(registerWebMcpTools(tools, controller.signal, host)).toBe(true);
    expect(registered).toHaveLength(tools.length);
    expect(registerWebMcpTools(tools, controller.signal, null)).toBe(false);
    expect(registerWebMcpTools(tools, controller.signal, {})).toBe(false);
  });
  it("keeps registering after a single rejected tool", () => {
    const registered: string[] = [];
    const host: ModelContextLike = {
      registerTool: (tool) => {
        if (tool.name === "cohort_compare") throw new Error("duplicate");
        registered.push(tool.name);
      },
    };
    const tools = buildWebMcpTools(() => context, { userId: "user-1" });
    expect(registerWebMcpTools(tools, new AbortController().signal, host)).toBe(true);
    expect(registered).toHaveLength(tools.length - 1);
  });
});
