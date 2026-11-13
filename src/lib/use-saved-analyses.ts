import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";

import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { analysisValuesSchema } from "@/src/lib/saved-analysis-model";
import type { SavedAnalysis } from "@/src/lib/saved-analysis-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

const initial = {
  scope: "",
  clientId: "",
  expectedRevision: 0,
  failureId: "",
  title: "",
  description: "",
  criteria: defaultCohortCriteria,
};
export function useSavedAnalyses() {
  const space = usePatientWorkspace();
  const { workspace, status } = space;
  const { t } = useLingui();
  const localAnalyses = useLiveQuery(() => workspace?.analyses);
  const analyses =
    workspace && Date.now() < workspace.expiresAt
      ? (localAnalyses.data ?? [])
          .filter((row) => row.clientId !== workspace.analysisSnapshotId && !row.deleted)
          .map(workspace.readAnalysis)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  const analysisForm = useForm({
    initialValues: initial,
    validate: (input) => {
      const result = analysisValuesSchema.safeParse(input);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
    },
  });
  const currentAnalysis = Boolean(workspace && analysisForm.values.scope === workspace.scope);
  const criteria = currentAnalysis ? analysisForm.values.criteria : defaultCohortCriteria;
  const assign = (input: typeof initial) => {
    analysisForm.setInitialValues(input);
    analysisForm.setValues(input);
    analysisForm.resetDirty(input);
    analysisForm.clearErrors();
  };
  const analysisFailures = useQuery({
    queryKey: ["analysis-failures", workspace?.scope],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: () => workspace!.failedActions("analysis"),
  });
  const saveAnalysis = useMutation({
    mutationKey: ["analysis-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope) throw new Error("WORKSPACE_LOCKED");
      const clientId = input.clientId || crypto.randomUUID();
      const result = await workspace.saveAnalysis({
        clientId,
        expectedRevision: input.expectedRevision,
        action: input.clientId ? "update" : "create",
        values: analysisValuesSchema.parse(input),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return { ...result, clientId };
    },
    onSuccess: (result, input) => {
      const current = analysisForm.getValues();
      if (
        current.scope === input.scope &&
        current.clientId === input.clientId &&
        current.expectedRevision === input.expectedRevision
      )
        assign({
          ...input,
          clientId: result.clientId,
          expectedRevision: input.expectedRevision + 1,
          failureId: "",
        });
      void status.refetch();
      void analysisFailures.refetch();
    },
  });
  const deleteAnalysis = useMutation({
    mutationKey: ["analysis-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (record: SavedAnalysis) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveAnalysis({
        clientId: record.clientId,
        expectedRevision: record.revision,
        action: "delete",
      });
      return { ...result, scope: workspace.scope };
    },
    onSuccess: (result, record) => {
      const current = analysisForm.getValues();
      if (current.clientId === record.clientId && current.scope === result.scope) assign(initial);
      void status.refetch();
      void analysisFailures.refetch();
    },
  });
  const restoreAnalysis = useMutation({
    mutationKey: ["analysis-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      if (failure.action === "delete") throw new Error("INVALID_ANALYSIS");
      const record = workspace.readAnalysis(failure.envelope);
      if (!record.values) throw new Error("INVALID_ANALYSIS");
      const current = workspace.analyses.get(record.clientId);
      assign({
        ...record.values,
        scope: workspace.scope,
        clientId: current && !current.deleted ? record.clientId : "",
        expectedRevision: current && !current.deleted ? current.revision : 0,
        failureId: failure.id,
      });
    },
  });
  return {
    ...space,
    analyses,
    localAnalyses,
    analysisForm,
    currentAnalysis,
    criteria,
    analysisFailures,
    saveAnalysis,
    deleteAnalysis,
    restoreAnalysis,
    newAnalysis: () => {
      if (workspace) assign({ ...initial, scope: workspace.scope });
    },
    loadAnalysis: (record: SavedAnalysis) => {
      if (workspace && record.values)
        assign({
          ...initial,
          ...record.values,
          scope: workspace.scope,
          clientId: record.clientId,
          expectedRevision: record.revision,
        });
    },
  };
}
