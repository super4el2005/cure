import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { hash } from "ohash";

import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";
import {
  compareCohorts,
  compareFixedCohorts,
  comparisonSourceSignature,
  freezeCohortSample,
  frozenSampleSignature,
} from "@/src/lib/cohort-comparison";
import { defaultCohortComparison } from "@/src/lib/cohort-comparison-model";
import {
  cohortLongitudinal,
  cohortLongitudinalSchema,
  defaultCohortLongitudinal,
} from "@/src/lib/cohort-longitudinal";
import {
  availableObservationCodes,
  cohortMemberIds,
  cohortStatistics,
  cohortStatisticsSchema,
  defaultCohortStatistics,
  statisticsSourceSignature,
} from "@/src/lib/cohort-statistics";
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
  comparisonEnabled: false,
  comparison: defaultCohortComparison,
};
function analysisInput(input: typeof initial) {
  const { comparisonEnabled, comparison, ...values } = input;
  return { ...values, ...(comparisonEnabled ? { comparison } : {}) };
}
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
      const result = analysisValuesSchema.safeParse(analysisInput(input));
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
        values: analysisValuesSchema.parse(analysisInput(input)),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return { ...result, clientId };
    },
    onSuccess: (result, input) => {
      const current = analysisForm.getValues();
      if (
        JSON.stringify(current) === JSON.stringify(input) &&
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
        ...initial,
        ...record.values,
        comparisonEnabled: Boolean(record.values.comparison),
        comparison: record.values.comparison ?? defaultCohortComparison,
        scope: workspace.scope,
        clientId: current && !current.deleted ? record.clientId : "",
        expectedRevision: current && !current.deleted ? current.revision : 0,
        failureId: failure.id,
      });
    },
  });
  const comparisonKey = hash({ criteria, comparison: analysisForm.values.comparison });
  const comparison = useMutation({
    mutationKey: ["analysis-compare"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { scope: string; key: string }) => {
      if (
        !workspace ||
        !currentAnalysis ||
        input.scope !== workspace.scope ||
        Date.now() >= workspace.expiresAt ||
        !space.downloaded.isReady
      )
        throw new Error("WORKSPACE_LOCKED");
      try {
        const settings = analysisForm.values.comparison;
        const role = space.opened?.role ?? "researcher";
        return {
          scope: workspace.scope,
          key: input.key,
          report: settings.fixedSample
            ? compareFixedCohorts(space.rows, role, criteria, settings, Date.now())
            : compareCohorts(space.rows, role, criteria, settings, Date.now()),
        };
      } catch {
        throw new Error("ANALYSIS_CALCULATION_FAILED");
      }
    },
  });
  const freezeSample = useMutation({
    mutationKey: ["analysis-freeze"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { scope: string }) => {
      if (
        !workspace ||
        !currentAnalysis ||
        input.scope !== workspace.scope ||
        Date.now() >= workspace.expiresAt ||
        !space.downloaded.isReady
      )
        throw new Error("WORKSPACE_LOCKED");
      let fixed;
      try {
        fixed = freezeCohortSample(
          space.rows,
          space.opened?.role ?? "researcher",
          criteria,
          analysisForm.values.comparison,
          Date.now(),
        );
      } catch {
        throw new Error("ANALYSIS_CALCULATION_FAILED");
      }
      analysisForm.setFieldValue("comparison.fixedSample", fixed);
    },
  });
  const unfreezeSample = () => analysisForm.setFieldValue("comparison.fixedSample", undefined);
  const comparisonResult =
    currentAnalysis &&
    analysisForm.values.comparisonEnabled &&
    comparison.data?.scope === workspace?.scope
      ? comparison.data
      : undefined;
  const comparisonStale = Boolean(
    comparisonResult &&
    (comparisonResult.key !== comparisonKey ||
      comparisonResult.report.signature !==
        (analysisForm.values.comparison.fixedSample
          ? frozenSampleSignature(
              space.rows,
              space.opened?.role ?? "researcher",
              analysisForm.values.comparison.fixedSample,
              Date.now(),
            )
          : comparisonSourceSignature(space.rows, space.opened?.role ?? "researcher", Date.now()))),
  );
  const localClinical = useLiveQuery(() => workspace?.clinicalRecords);
  const doctorRows = workspace && space.opened?.role === "doctor" ? workspace : null;
  const clinicalRows =
    doctorRows && Date.now() < doctorRows.expiresAt
      ? (localClinical.data
          ?.filter((row) => row.clientId !== doctorRows.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              return [doctorRows.readClinical(envelope)];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          }) ?? [])
      : [];
  const statisticsForm = useForm({
    initialValues: defaultCohortStatistics,
    validate: (input) => {
      const result = cohortStatisticsSchema.safeParse(input);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
    },
  });
  const statisticsMembers =
    doctorRows && currentAnalysis
      ? cohortMemberIds(space.rows, "doctor", criteria, Date.now())
      : new Set<string>();
  const statisticsCodes = availableObservationCodes(clinicalRows, statisticsMembers);
  const statisticsKey = hash({ criteria, statistics: statisticsForm.values });
  const statistics = useMutation({
    mutationKey: ["analysis-statistics"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { scope: string; key: string }) => {
      if (
        !workspace ||
        !doctorRows ||
        !currentAnalysis ||
        input.scope !== workspace.scope ||
        Date.now() >= workspace.expiresAt ||
        !space.downloaded.isReady
      )
        throw new Error("WORKSPACE_LOCKED");
      try {
        return {
          scope: workspace.scope,
          key: input.key,
          report: cohortStatistics(
            space.rows,
            "doctor",
            criteria,
            clinicalRows,
            statisticsForm.values,
            Date.now(),
          ),
        };
      } catch {
        throw new Error("ANALYSIS_CALCULATION_FAILED");
      }
    },
  });
  const statisticsResult =
    currentAnalysis && statistics.data?.scope === workspace?.scope ? statistics.data : undefined;
  const statisticsStale = Boolean(
    statisticsResult &&
    (statisticsResult.key !== statisticsKey ||
      statisticsResult.report.signature !==
        statisticsSourceSignature(space.rows, "doctor", criteria, clinicalRows, Date.now())),
  );
  const longitudinalForm = useForm({
    initialValues: defaultCohortLongitudinal,
    validate: (input) => {
      const result = cohortLongitudinalSchema.safeParse(input);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
    },
  });
  const longitudinalKey = hash({ criteria, longitudinal: longitudinalForm.values });
  const longitudinal = useMutation({
    mutationKey: ["analysis-longitudinal"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { scope: string; key: string }) => {
      if (
        !workspace ||
        !doctorRows ||
        !currentAnalysis ||
        input.scope !== workspace.scope ||
        Date.now() >= workspace.expiresAt ||
        !space.downloaded.isReady
      )
        throw new Error("WORKSPACE_LOCKED");
      try {
        return {
          scope: workspace.scope,
          key: input.key,
          report: cohortLongitudinal(
            space.rows,
            "doctor",
            criteria,
            clinicalRows,
            longitudinalForm.values,
            Date.now(),
          ),
        };
      } catch {
        throw new Error("ANALYSIS_CALCULATION_FAILED");
      }
    },
  });
  const longitudinalResult =
    currentAnalysis && longitudinal.data?.scope === workspace?.scope
      ? longitudinal.data
      : undefined;
  const longitudinalStale = Boolean(
    longitudinalResult &&
    (longitudinalResult.key !== longitudinalKey ||
      longitudinalResult.report.signature !==
        statisticsSourceSignature(space.rows, "doctor", criteria, clinicalRows, Date.now())),
  );
  return {
    ...space,
    comparison,
    comparisonKey,
    comparisonResult,
    comparisonStale,
    freezeSample,
    unfreezeSample,
    statistics,
    statisticsKey,
    statisticsResult,
    statisticsStale,
    statisticsCodes,
    statisticsForm,
    longitudinal,
    longitudinalKey,
    longitudinalResult,
    longitudinalStale,
    longitudinalForm,
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
          comparisonEnabled: Boolean(record.values.comparison),
          comparison: record.values.comparison ?? defaultCohortComparison,
          scope: workspace.scope,
          clientId: record.clientId,
          expectedRevision: record.revision,
        });
    },
  };
}
