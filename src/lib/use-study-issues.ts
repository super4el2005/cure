import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { studyIssuePayloadSchema } from "@/src/lib/study-issue-model";
import type { StudyIssuePayload } from "@/src/lib/study-issue-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

const initial = {
  scope: "",
  projectId: "",
  clientId: "",
  patientClientId: "",
  expectedRevision: 0,
  failureId: "",
  enrollmentClientId: "",
  protocolClientId: "",
  protocolVersion: 0,
  original: null as StudyIssuePayload | null,
  category: "adverseEvent" as "adverseEvent" | "deviation",
  title: "",
  description: "",
  occurredOn: null as string | null,
  detectedOn: null as string | null,
  notes: "",
  status: "open" as StudyIssuePayload["status"],
  reviewerId: "",
  reviewDueOn: null as string | null,
  resolution: "",
  reviewedOn: null as string | null,
  amendmentReason: "",
  severity: "mild" as "mild" | "moderate" | "severe",
  seriousness: [] as Extract<StudyIssuePayload["details"], { type: "adverseEvent" }>["seriousness"],
  causality: "unassessed" as Extract<
    StudyIssuePayload["details"],
    { type: "adverseEvent" }
  >["causality"],
  expectedness: "unknown" as "unknown" | "expected" | "unexpected",
  suspectAgent: "",
  actionTaken: "",
  outcome: "unknown" as Extract<StudyIssuePayload["details"], { type: "adverseEvent" }>["outcome"],
  endedOn: null as string | null,
  impact: "minor" as "minor" | "major" | "critical",
  protocolSection: "",
  rootCause: "",
  correctiveAction: "",
  preventiveAction: "",
};
function payload(input: typeof initial, userId: string) {
  const final = ["resolved", "closed"].includes(input.status);
  const old = input.original;
  const reviewChanged =
    !old ||
    old.status !== input.status ||
    old.reviewerId !== input.reviewerId ||
    old.resolution !== input.resolution ||
    old.reviewedOn !== (input.reviewedOn ?? "");
  return {
    kind: "studyIssue" as const,
    writeId: crypto.randomUUID(),
    projectClientId: input.projectId,
    enrollmentClientId: input.enrollmentClientId,
    protocolClientId: input.protocolClientId,
    protocolVersion: input.protocolVersion,
    title: input.title,
    description: input.description,
    occurredOn: input.occurredOn ?? "",
    detectedOn: input.detectedOn ?? "",
    notes: input.notes,
    status: input.status,
    reviewerId: input.reviewerId,
    reviewDueOn: input.reviewDueOn ?? "",
    resolution: final ? input.resolution : "",
    reviewedOn: final ? (input.reviewedOn ?? "") : "",
    reviewedBy: final ? (reviewChanged ? userId : old!.reviewedBy) : "",
    amendmentReason: input.amendmentReason,
    details:
      input.category === "adverseEvent"
        ? {
            type: "adverseEvent" as const,
            severity: input.severity,
            seriousness: input.seriousness,
            causality: input.causality,
            expectedness: input.expectedness,
            suspectAgent: input.suspectAgent,
            actionTaken: input.actionTaken,
            outcome: input.outcome,
            endedOn: input.endedOn ?? "",
          }
        : {
            type: "deviation" as const,
            impact: input.impact,
            protocolSection: input.protocolSection,
            rootCause: input.rootCause,
            correctiveAction: input.correctiveAction,
            preventiveAction: input.preventiveAction,
          },
  };
}
export function useStudyIssues(projectId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status } = space;
  const convex = useConvex();
  const { t } = useLingui();
  const source = useLiveQuery(() => workspace?.clinicalRecords);
  const records =
    workspace && opened?.role === "doctor" && Date.now() < workspace.expiresAt
      ? (source.data ?? [])
          .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              return [workspace.readClinical(envelope)];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          })
      : [];
  const enrollments = records.filter(
    (row) => row.payload?.kind === "enrollment" && row.payload.projectClientId === projectId,
  );
  const cases = records
    .filter(
      (row) => row.payload?.kind === "studyIssue" && row.payload.projectClientId === projectId,
    )
    .sort((a, b) =>
      a.payload?.kind === "studyIssue" && b.payload?.kind === "studyIssue"
        ? a.payload.reviewDueOn.localeCompare(b.payload.reviewDueOn)
        : 0,
    );
  const reviewers = useQuery({
    queryKey: ["issue-reviewers", workspace?.scope, status.data?.online],
    enabled: Boolean(workspace && opened?.role === "doctor"),
    gcTime: 0,
    networkMode: "always",
    queryFn: async () => {
      if (status.data?.online) {
        const rows = await convex.query(api.clinicalRecords.reviewers, {
          actorId: userId!,
          organizationId: workspace!.organizationId,
        });
        await workspace!.cacheReviewers(rows);
        return rows;
      }
      return workspace!.cachedReviewers();
    },
  });
  const reviewerOptions = (reviewers.data ?? []).map((row) => ({
    value: row.userId,
    label: row.displayName,
  }));
  if (userId && !reviewerOptions.some((row) => row.value === userId))
    reviewerOptions.unshift({ value: userId, label: t`Я` });
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (input) => {
      const result = studyIssuePayloadSchema.safeParse(payload(input, userId ?? ""));
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [
              String(issue.path[0] ?? "_form"),
              t`Проверьте даты, обязательные поля и сведения о рассмотрении`,
            ]),
          );
    },
  });
  const assign = (record?: ClinicalRecord, failureId = "") => {
    if (!workspace) return;
    const value = record?.payload?.kind === "studyIssue" ? record.payload : null;
    const envelope = record ? workspace.clinicalRecords.get(record.clientId) : undefined;
    const current =
      failureId && envelope && !envelope.deleted ? workspace.readClinical(envelope) : record;
    const original =
      current?.payload?.kind === "studyIssue" && (!failureId || (envelope && !envelope.deleted))
        ? current.payload
        : null;
    const date = new Date().toISOString().slice(0, 10);
    const input = {
      ...initial,
      scope: workspace.scope,
      projectId,
      clientId: original ? current!.clientId : "",
      patientClientId: record?.patientClientId ?? "",
      expectedRevision: original ? current!.revision : 0,
      failureId,
      original,
      enrollmentClientId: value?.enrollmentClientId ?? "",
      protocolClientId: value?.protocolClientId ?? "",
      protocolVersion: value?.protocolVersion ?? 0,
      category: value?.details.type ?? "adverseEvent",
      title: value?.title ?? "",
      description: value?.description ?? "",
      occurredOn: value?.occurredOn ?? date,
      detectedOn: value?.detectedOn ?? date,
      notes: value?.notes ?? "",
      status: value?.status ?? "open",
      reviewerId: value?.reviewerId ?? userId ?? "",
      reviewDueOn: value?.reviewDueOn ?? null,
      resolution: value?.resolution ?? "",
      reviewedOn: value?.reviewedOn || null,
      amendmentReason: failureId ? (value?.amendmentReason ?? "") : "",
      ...(value?.details.type === "adverseEvent" ? value.details : {}),
      ...(value?.details.type === "deviation" ? value.details : {}),
      endedOn: value?.details.type === "adverseEvent" ? value.details.endedOn || null : null,
    };
    const baseline = failureId ? { ...initial, scope: workspace.scope, projectId } : input;
    form.setInitialValues(baseline);
    form.setValues(input);
    form.resetDirty(baseline);
    form.clearErrors();
    editor.open();
  };
  const selectEnrollment = (id: string | null) => {
    const row = enrollments.find((value) => value.clientId === id);
    if (row?.payload?.kind !== "enrollment") return;
    form.setValues({
      enrollmentClientId: row.clientId,
      patientClientId: row.patientClientId,
      protocolClientId: row.payload.protocolClientId,
      protocolVersion: row.payload.protocolVersion,
    });
  };
  const failures = useQuery({
    queryKey: ["issue-failures", workspace?.scope, projectId],
    enabled: Boolean(workspace && opened?.role === "doctor"),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("clinical")).filter((failure) => {
        try {
          const row = workspace!.readClinical(failure.envelope);
          return row.payload?.kind === "studyIssue" && row.payload.projectClientId === projectId;
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return false;
          throw error;
        }
      }),
  });
  const saveCase = useMutation({
    mutationKey: ["issue-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope || input.projectId !== projectId)
        throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveClinical({
        clientId: input.clientId || crypto.randomUUID(),
        patientClientId: input.patientClientId,
        expectedRevision: input.expectedRevision,
        action: input.clientId ? "update" : "create",
        payload: studyIssuePayloadSchema.parse(payload(input, userId!)),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (
        form.getValues().scope === input.scope &&
        form.getValues().clientId === input.clientId &&
        form.getValues().expectedRevision === input.expectedRevision
      ) {
        form.setInitialValues(initial);
        form.setValues(initial);
        form.resetDirty(initial);
        editor.close();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const deleteCase = useMutation({
    mutationKey: ["issue-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (row: ClinicalRecord) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveClinical({
        clientId: row.clientId,
        patientClientId: row.patientClientId,
        expectedRevision: row.revision,
        action: "delete",
      });
    },
    onSuccess: (_result, row) => {
      if (form.getValues().clientId === row.clientId) {
        form.setValues(initial);
        form.setInitialValues(initial);
        form.resetDirty(initial);
        editor.close();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const restoreCase = useMutation({
    mutationKey: ["issue-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      if (failure.action === "delete") throw new Error("INVALID_CLINICAL_RECORD");
      assign(workspace.readClinical(failure.envelope), failure.id);
    },
  });
  const dirty = () =>
    editing &&
    Boolean(workspace) &&
    form.values.scope === workspace?.scope &&
    form.values.projectId === projectId &&
    form.isDirty();
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: dirty,
    enableBeforeUnload: dirty,
  });
  return {
    ...space,
    source,
    enrollments,
    cases,
    reviewers,
    reviewerOptions,
    editing,
    editor,
    form,
    selectEnrollment,
    failures,
    saveCase,
    deleteCase,
    restoreCase,
    blocker,
    start: () => assign(),
    editCase: (row: ClinicalRecord) => assign(row),
  };
}
