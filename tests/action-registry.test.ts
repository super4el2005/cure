import { describe, expect, it } from "@rstest/core";

import { createActionJournal } from "@/src/lib/action-journal";
import { createActionRegistry, cureActions } from "@/src/lib/action-registry";
import type { ActionActor, ActionContext } from "@/src/lib/action-registry";
import { clinicalRecordSchema } from "@/src/lib/clinical-record-model";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import { defaultCohortComparison } from "@/src/lib/cohort-comparison-model";
import { patientRowSchema } from "@/src/lib/patient-model";
import type { PatientRow } from "@/src/lib/patient-model";
import { savedAnalysisSchema } from "@/src/lib/saved-analysis-model";

const actor: ActionActor = {
  kind: "assistant",
  interface: "chat",
  userId: "user-1",
  model: "test",
};
function patient(group: string, positive: boolean, extra: Partial<PatientRow> = {}) {
  return patientRowSchema.parse({
    clientId: crypto.randomUUID(),
    revision: 1,
    deleted: false,
    fullName: "Private name",
    birthDate: "1990-01-01",
    sex: "female",
    diagnosisCodes: [group, ...(positive ? ["X"] : [])],
    notes: "Private notes",
    updatedAt: 1,
    consentApproved: true,
    consentScope: ["sex", "diagnoses"],
    accessExpiresAt: 100,
    ...extra,
  });
}
const rows = () => [
  ...Array.from({ length: 5 }, (_, i) => patient("A", i < 2)),
  ...Array.from({ length: 5 }, (_, i) => patient("B", i < 3)),
];
function context(extra: Partial<ActionContext> = {}): ActionContext {
  return {
    workspace: null,
    rows: rows(),
    clinicalRows: [],
    analyses: [],
    role: "researcher",
    now: 50,
    ...extra,
  };
}
const registry = createActionRegistry();

describe("action registry core", () => {
  it("lists the built-in actions with their contracts", () => {
    const list = registry.list();
    expect(list.map(({ id }) => id).sort()).toEqual([...cureActions.map(({ id }) => id)].sort());
    expect(list.find(({ id }) => id === "analysis.save")).toMatchObject({
      kind: "write",
      destructive: false,
    });
    expect(() => createActionRegistry([cureActions[0]!, cureActions[0]!])).toThrow(
      "DUPLICATE_ACTION",
    );
  });
  it("aggregates the patient overview through shared selection semantics", () => {
    const output = registry.run(context(), actor, "patients.overview", {});
    return expect(output).resolves.toMatchObject({
      available: 10,
      selected: 10,
      sexDenominator: 10,
      diagnosisDenominator: 10,
    });
  });
  it("reuses the cohort comparison engine without leaking identifiers", async () => {
    const output = (await registry.run(context({ role: "doctor" }), actor, "cohort.compare", {
      criteria: { ...defaultCohortCriteria, include: ["A"] },
      comparison: {
        ...defaultCohortComparison,
        independent: true,
        reference: { ...defaultCohortCriteria, include: ["B"] },
        outcome: { kind: "diagnosis", code: "X" },
      },
    })) as { groups: { selected: number }[] };
    expect(output.groups[0]).toMatchObject({ selected: 5 });
    expect(JSON.stringify(output)).not.toMatch(/Private|1990/);
  });
  it("enforces roles, action existence and input validation with journal entries", async () => {
    const journal = createActionJournal();
    const restricted = context({ role: "researcher", journal });
    await expect(registry.run(restricted, actor, "observations.codes", {})).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(registry.run(restricted, actor, "missing.action", {})).rejects.toThrow(
      "UNKNOWN_ACTION",
    );
    await expect(
      registry.run(restricted, actor, "cohort.summarize", { criteria: { sex: "any" } }),
    ).rejects.toThrow("INVALID_INPUT");
    const entries = journal.list();
    expect(entries.map(({ error }) => error)).toEqual([
      "ACCESS_DENIED",
      "UNKNOWN_ACTION",
      "INVALID_INPUT",
    ]);
    expect(entries.every((entry) => entry.actor.userId === "user-1")).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/Private|1990/);
  });
  it("lists only the caller's own analysis definitions without values", async () => {
    const analyses = [
      savedAnalysisSchema.parse({
        clientId: crypto.randomUUID(),
        revision: 2,
        deleted: false,
        values: { title: "My analysis", description: "d", criteria: defaultCohortCriteria },
        createdAt: 1,
        updatedAt: 20,
      }),
      savedAnalysisSchema.parse({
        clientId: crypto.randomUUID(),
        revision: 3,
        deleted: true,
        values: null,
        createdAt: 1,
        updatedAt: 30,
      }),
    ];
    const output = (await registry.run(context({ analyses }), actor, "analyses.list", {})) as {
      analyses: { title: string }[];
    };
    expect(output.analyses).toHaveLength(1);
    expect(output.analyses[0]).not.toHaveProperty("values");
    expect(output.analyses[0]!.title).toBe("My analysis");
  });
  it("returns observation codes for the doctor only", async () => {
    const members = rows();
    const clinicalRows = [
      clinicalRecordSchema.parse({
        clientId: crypto.randomUUID(),
        patientClientId: members[0]!.clientId,
        revision: 1,
        deleted: false,
        payload: {
          kind: "observation",
          occurredOn: "2025-01-10",
          notes: "",
          name: "HbA1c",
          code: "HbA1c",
          numericValue: 6.1,
          textValue: "",
          unit: "%",
        },
        createdAt: 1,
        updatedAt: 1,
      }),
    ];
    const output = (await registry.run(
      context({ role: "doctor", rows: members, clinicalRows }),
      actor,
      "observations.codes",
      {},
    )) as { codes: string[] };
    expect(output.codes).toEqual(["HbA1c"]);
  });
  it("routes writes through the workspace with its own validation and queue", async () => {
    const calls: unknown[] = [];
    const workspace = {
      saveAnalysis: async (command: unknown) => {
        calls.push(command);
        return { transactionId: "tx-1" };
      },
    };
    const output = (await registry.run(
      context({ workspace: workspace as never }),
      actor,
      "analysis.save",
      {
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        values: { title: "New", description: "", criteria: defaultCohortCriteria },
      },
    )) as { transactionId: string };
    expect(output.transactionId).toBe("tx-1");
    expect(calls).toHaveLength(1);
    await expect(
      registry.run(context(), actor, "analysis.save", {
        values: { title: "New", description: "", criteria: defaultCohortCriteria },
      }),
    ).rejects.toThrow("WORKSPACE_LOCKED");
  });
});
