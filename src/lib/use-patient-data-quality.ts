import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useMemo } from "react";

import { qualityReviewPayloadSchema } from "@/src/lib/data-quality-model";
import type { QualityReviewPayload } from "@/src/lib/data-quality-model";
import { analyzePatientQuality, qualitySourceSignature } from "@/src/lib/patient-data-quality";
import type { QualityFinding } from "@/src/lib/patient-data-quality";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { useClinicalHistory } from "@/src/lib/use-clinical-history";

export function usePatientDataQuality(patientId: string) {
  const { t } = useLingui();
  const space = useClinicalHistory(patientId, false);
  const { workspace, opened, records, current, patients, status } = space;
  const patient = space.rows.find((row) => row.clientId === patientId);
  const today = new Date().toISOString().slice(0, 10);
  const canCheck = Boolean(
    workspace &&
    opened?.role === "doctor" &&
    patient &&
    Date.now() < workspace.expiresAt &&
    current.isReady &&
    patients.isReady &&
    workspace.clinicalRecords.has(workspace.clinicalSnapshotId) &&
    workspace.collection.has(workspace.patientSnapshotId),
  );
  const check = useMutation({
    mutationKey: ["quality-check"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: { scope: string; patientId: string }) => {
      if (
        !canCheck ||
        !workspace ||
        !patient ||
        input.scope !== workspace.scope ||
        input.patientId !== patientId
      )
        throw new Error("WORKSPACE_NOT_READY");
      return {
        scope: workspace.scope,
        patientId,
        report: analyzePatientQuality(patient, records, today),
      };
    },
  });
  const result =
    canCheck &&
    check.data &&
    check.data.scope === workspace?.scope &&
    check.data.patientId === patientId
      ? check.data.report
      : undefined;
  const parent = workspace?.collection.get(patientId);
  const currentSignature = useMemo(() => {
    if (!result || !canCheck || !workspace || !parent) return null;
    try {
      return qualitySourceSignature(workspace.read(parent), records, today);
    } catch {
      return null;
    }
  }, [result, canCheck, workspace, parent, records, today]);
  const stale = Boolean(result && result.sourceSignature !== currentSignature);
  const reviewForm = useForm({
    initialValues: {
      scope: "",
      clientId: "",
      patientId: "",
      sourceSignature: "",
      evaluationDate: "",
      findingKey: "",
      code: "sexMissing" as QualityFinding["code"],
      decision: "needsClarification" as QualityReviewPayload["decision"],
      notes: "",
      failureId: "",
    },
    validate: {
      notes: (value) =>
        value.trim().length > 0 && value.trim().length <= 2000
          ? null
          : t`Добавьте обоснование решения`,
    },
  });
  const formCurrent = Boolean(
    workspace &&
    reviewForm.values.scope === workspace.scope &&
    reviewForm.values.patientId === patientId &&
    reviewForm.values.findingKey,
  );
  const formStale = Boolean(
    formCurrent &&
    (!result || stale || reviewForm.values.sourceSignature !== result.sourceSignature),
  );
  const dirty = () => formCurrent && reviewForm.isDirty();
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: dirty,
    enableBeforeUnload: dirty,
  });
  const failures = useQuery({
    queryKey: ["quality-failures", workspace?.scope, patientId],
    enabled: opened?.role === "doctor",
    networkMode: "always",
    gcTime: 0,
    refetchInterval: 2000,
    queryFn: async () => {
      if (!workspace || opened?.role !== "doctor") return [];
      const failed = await workspace!.failedActions("clinical");
      return failed.flatMap((failure) => {
        try {
          const row = workspace!.readClinical(failure.envelope);
          return row.patientClientId === patientId && row.payload?.kind === "qualityReview"
            ? [{ ...failure, review: row.payload }]
            : [];
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
          throw error;
        }
      });
    },
  });
  const save = useMutation({
    mutationKey: ["quality-review"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof reviewForm.values) => {
      if (
        !workspace ||
        !canCheck ||
        input.scope !== workspace.scope ||
        input.patientId !== patientId
      )
        throw new Error("WORKSPACE_LOCKED");
      if (workspace.qualityReviewVersion !== "patient-quality-v1")
        throw new Error("QUALITY_NOT_PREPARED");
      if (input.evaluationDate !== new Date().toISOString().slice(0, 10))
        throw new Error("QUALITY_SOURCE_CHANGED");
      const payload = qualityReviewPayloadSchema.parse({
        kind: "qualityReview",
        writeId: crypto.randomUUID(),
        occurredOn: today,
        notes: input.notes,
        algorithmVersion: "patient-quality-v1",
        evaluationDate: input.evaluationDate,
        sourceSignature: input.sourceSignature,
        findingKey: input.findingKey,
        code: input.code,
        decision: input.decision,
        reviewedBy: opened!.userId,
      });
      const result = await workspace.saveClinical({
        clientId: input.clientId,
        patientClientId: patientId,
        expectedRevision: 0,
        expectedHistoryId: null,
        action: "create",
        payload,
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (JSON.stringify(reviewForm.getValues()) === JSON.stringify(input)) reviewForm.reset();
      void status.refetch();
      void failures.refetch();
    },
  });
  const setReview = (
    finding: QualityFinding,
    notes = "",
    decision: QualityReviewPayload["decision"] = "needsClarification",
    failureId = "",
  ) => {
    if (!workspace || !result || stale) throw new Error("QUALITY_SOURCE_CHANGED");
    save.reset();
    reviewForm.setValues({
      scope: workspace.scope,
      clientId: crypto.randomUUID(),
      patientId,
      sourceSignature: result.sourceSignature,
      evaluationDate: result.evaluationDate,
      findingKey: finding.key,
      code: finding.code,
      notes,
      decision,
      failureId,
    });
    reviewForm.clearErrors();
  };
  const prepare = useMutation({
    mutationKey: ["quality-prepare"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (finding: QualityFinding) => {
      setReview(finding);
    },
  });
  const restore = useMutation({
    mutationKey: ["quality-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace || failure.action === "delete") throw new Error("INVALID_QUALITY_REVIEW");
      const row = workspace.readClinical(failure.envelope);
      const value = row.payload;
      if (row.patientClientId !== patientId || value?.kind !== "qualityReview")
        throw new Error("INVALID_QUALITY_REVIEW");
      const finding = result?.findings.find(
        (finding) => finding.key === value.findingKey && finding.code === value.code,
      );
      if (!finding) throw new Error("QUALITY_SOURCE_CHANGED");
      setReview(finding, value.notes, value.decision, failure.id);
    },
  });
  const dismiss = useMutation({
    mutationKey: ["quality-dismiss"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace || opened?.role !== "doctor" || Date.now() >= workspace.expiresAt)
        throw new Error("WORKSPACE_LOCKED");
      const row = workspace.readClinical(failure.envelope);
      if (row.patientClientId !== patientId || row.payload?.kind !== "qualityReview")
        throw new Error("INVALID_QUALITY_REVIEW");
      await workspace.dismissFailure(failure.id);
    },
    onSuccess: () => {
      void failures.refetch();
    },
  });
  return {
    ...space,
    blocker,
    patient,
    today,
    canCheck,
    check,
    result,
    stale,
    reviewForm,
    formCurrent,
    formStale,
    failures,
    save,
    restore,
    dismiss,
    prepare,
    begin: (finding: QualityFinding) => prepare.mutate(finding),
    reviews: records
      .filter((row) => row.payload?.kind === "qualityReview")
      .toSorted((a, b) => b.updatedAt - a.updatedAt),
  };
}
