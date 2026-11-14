import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";

import { clinicalPayloadSchema } from "@/src/lib/clinical-record-model";
import type { ClinicalRecord, VisitPayload } from "@/src/lib/clinical-record-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { retainedWorkspaceOptions } from "@/src/lib/retained-workspaces";
import { studyVisitNeedsAuthorization } from "@/src/lib/study-visit-model";
import type { StudyVisitPayload } from "@/src/lib/study-visit-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";
import { resolveVisitTime, visitTime } from "@/src/lib/visit-time";

const initial = {
  scope: "",
  projectId: "",
  clientId: "",
  patientClientId: "",
  expectedRevision: 0,
  expectedHistoryId: null as string | null,
  failureId: "",
  enrollmentClientId: "",
  enrollmentWriteId: "",
  protocolClientId: "",
  protocolVersion: 0,
  original: null as StudyVisitPayload | null,
  scheduledLocal: null as string | null,
  timeZone: "UTC",
  disambiguation: "reject" as "reject" | "earlier" | "later",
  durationMinutes: 30 as number | string,
  visitType: "followUp" as VisitPayload["visitType"],
  status: "planned" as VisitPayload["status"],
  reason: "",
  location: "",
  outcome: "",
  notes: "",
  cancellationReason: "",
  windowFrom: null as string | null,
  windowTo: null as string | null,
  performedOn: null as string | null,
  deviationReason: "",
  amendmentReason: "",
};
function payload(input: typeof initial): StudyVisitPayload {
  const scheduledFor = resolveVisitTime(
    input.scheduledLocal ?? "",
    input.timeZone,
    input.disambiguation,
  );
  const result = clinicalPayloadSchema.parse({
    kind: "studyVisit",
    writeId: crypto.randomUUID(),
    projectClientId: input.projectId,
    patientClientId: input.patientClientId,
    enrollmentClientId: input.enrollmentClientId,
    enrollmentWriteId: input.enrollmentWriteId,
    protocolClientId: input.protocolClientId,
    protocolVersion: input.protocolVersion,
    occurredOn: visitTime(scheduledFor).date,
    scheduledFor,
    durationMinutes: input.durationMinutes,
    visitType: input.visitType,
    status: input.status,
    reason: input.reason,
    location: input.location,
    outcome: input.outcome,
    notes: input.notes,
    followUpOn: "",
    cancellationReason: input.cancellationReason,
    windowFrom: input.windowFrom ?? "",
    windowTo: input.windowTo ?? "",
    performedOn: input.performedOn ?? "",
    deviationReason: input.deviationReason,
    amendmentReason: input.amendmentReason,
  });
  if (result.kind !== "studyVisit") throw new Error("INVALID_CLINICAL_RECORD");
  return result;
}
export function useStudyVisits(projectId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status, rows: patients } = space;
  const { t } = useLingui();
  const retained = useQuery(retainedWorkspaceOptions);
  const entry = retained.data.find(
    (row) =>
      row.kind === "projects" &&
      row.userId === userId &&
      row.workspace.organizationId === workspace?.organizationId,
  );
  const projects =
    entry?.kind === "projects" && Date.now() < entry.workspace.expiresAt
      ? entry.workspace
      : undefined;
  const projectSource = useLiveQuery(() => projects?.collection);
  const protocolSource = useLiveQuery(() => projects?.protocols);
  const project = projects
    ? (projectSource.data ?? [])
        .filter((row) => row.clientId !== projects.projectSnapshotId)
        .map(projects.read)
        .find((row) => row.clientId === projectId)
    : undefined;
  const protocol = projects
    ? (protocolSource.data ?? [])
        .filter((row) => row.clientId !== projects.protocolSnapshotId)
        .map(projects.readProtocol)
        .filter((row) => row.projectClientId === projectId)
        .sort((a, b) => b.version - a.version)[0]
    : undefined;
  const canConduct = Boolean(
    project &&
    project.selfRole !== "viewer" &&
    ["recruiting", "active"].includes(project.status) &&
    protocol?.confirmed &&
    protocol.ethicsApproved &&
    protocol.ethicsExpiresAt > Date.now(),
  );
  const source = useLiveQuery(() => workspace?.clinicalRecords);
  const records =
    workspace && opened?.role === "doctor"
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
  const available = enrollments.filter(
    (row) =>
      row.payload?.kind === "enrollment" &&
      row.payload.events.at(-1)?.status === "enrolled" &&
      row.payload.events.at(-1)!.consent!.expiresOn >= new Date().toISOString().slice(0, 10) &&
      row.payload.protocolClientId === protocol?.clientId,
  );
  const visits = records
    .filter(
      (row) => row.payload?.kind === "studyVisit" && row.payload.projectClientId === projectId,
    )
    .sort((a, b) =>
      a.payload?.kind === "studyVisit" && b.payload?.kind === "studyVisit"
        ? visitTime(a.payload.scheduledFor).epoch - visitTime(b.payload.scheduledFor).epoch
        : 0,
    );
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (input) => {
      try {
        payload(input);
        return {};
      } catch (error) {
        return {
          scheduledLocal:
            error instanceof Error && error.message === "AMBIGUOUS_VISIT_TIME"
              ? t`Этот час повторяется дважды. Выберите первое или второе вхождение.`
              : t`Проверьте расписание, окно визита, результат и обоснование отклонения. Для выполненного визита нужна фактическая дата.`,
        };
      }
    },
  });
  const assign = (record?: ClinicalRecord, failureId = "") => {
    if (!workspace) return;
    const value = record?.payload?.kind === "studyVisit" ? record.payload : null;
    const envelope = record ? workspace.clinicalRecords.get(record.clientId) : undefined;
    const current =
      failureId && envelope && !envelope.deleted ? workspace.readClinical(envelope) : record;
    const original =
      current?.payload?.kind === "studyVisit" && (!failureId || (envelope && !envelope.deleted))
        ? current.payload
        : null;
    const enrollment = value
      ? enrollments.find((row) => row.clientId === value.enrollmentClientId)
      : undefined;
    const scheduled = value ? visitTime(value.scheduledFor) : null;
    const values = {
      ...initial,
      scope: workspace.scope,
      projectId,
      clientId: original ? current!.clientId : "",
      patientClientId: record?.patientClientId ?? "",
      expectedRevision: original ? current!.revision : 0,
      expectedHistoryId: original ? (current!.historyId ?? null) : null,
      failureId,
      original,
      enrollmentClientId: value?.enrollmentClientId ?? "",
      enrollmentWriteId:
        enrollment?.payload?.kind === "enrollment"
          ? enrollment.payload.writeId
          : (value?.enrollmentWriteId ?? ""),
      protocolClientId: value?.protocolClientId ?? "",
      protocolVersion: value?.protocolVersion ?? 0,
      scheduledLocal: scheduled?.local ?? null,
      timeZone: scheduled?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      disambiguation: scheduled
        ? visitTime(resolveVisitTime(scheduled.local, scheduled.timeZone, "earlier")).epoch ===
          scheduled.epoch
          ? ("earlier" as const)
          : ("later" as const)
        : ("reject" as const),
      durationMinutes: value?.durationMinutes ?? 30,
      visitType: value?.visitType ?? ("followUp" as const),
      status: value?.status ?? ("planned" as const),
      reason: value?.reason ?? "",
      location: value?.location ?? "",
      outcome: value?.outcome ?? "",
      notes: value?.notes ?? "",
      cancellationReason: value?.cancellationReason ?? "",
      windowFrom: value?.windowFrom ?? null,
      windowTo: value?.windowTo ?? null,
      performedOn: value?.performedOn || null,
      deviationReason: value?.deviationReason ?? "",
      amendmentReason: failureId ? (value?.amendmentReason ?? "") : "",
    };
    form.setInitialValues(values);
    form.setValues(values);
    form.resetDirty(values);
    form.clearErrors();
    editor.open();
  };
  const selectEnrollment = (clientId: string | null) => {
    const row = available.find((item) => item.clientId === clientId);
    if (row?.payload?.kind !== "enrollment") return;
    form.setValues({
      enrollmentClientId: row.clientId,
      patientClientId: row.patientClientId,
      enrollmentWriteId: row.payload.writeId,
      protocolClientId: row.payload.protocolClientId,
      protocolVersion: row.payload.protocolVersion,
    });
  };
  const failures = useQuery({
    queryKey: ["study-visit-failures", workspace?.scope, projectId],
    enabled: Boolean(workspace && opened?.role === "doctor"),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("clinical")).filter((failure) => {
        try {
          const row = workspace!.readClinical(failure.envelope);
          return row.payload?.kind === "studyVisit" && row.payload.projectClientId === projectId;
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return false;
          throw error;
        }
      }),
  });
  const save = useMutation({
    mutationKey: ["study-visit-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope || input.projectId !== projectId)
        throw new Error("WORKSPACE_LOCKED");
      const parsed = payload(input);
      if (studyVisitNeedsAuthorization(input.original, parsed) && !canConduct)
        throw new Error("ACCESS_DENIED");
      const result = await workspace.saveClinical({
        clientId: input.clientId || crypto.randomUUID(),
        patientClientId: input.patientClientId,
        expectedRevision: input.expectedRevision,
        expectedHistoryId: input.expectedHistoryId,
        action: input.clientId ? "update" : "create",
        payload: parsed,
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (
        form.getValues().scope === input.scope &&
        form.getValues().clientId === input.clientId &&
        form.getValues().expectedRevision === input.expectedRevision &&
        form.getValues().expectedHistoryId === input.expectedHistoryId
      ) {
        editor.close();
        form.reset();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const remove = useMutation({
    mutationKey: ["study-visit-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (record: ClinicalRecord) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveClinical({
        clientId: record.clientId,
        patientClientId: record.patientClientId,
        expectedRevision: record.revision,
        expectedHistoryId: record.historyId ?? null,
        action: "delete",
      });
    },
    onSuccess: () => {
      void status.refetch();
      void failures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["study-visit-restore"],
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
    projects,
    project,
    protocol,
    canConduct,
    source,
    enrollments,
    available,
    visits,
    patients,
    editing,
    editor,
    form,
    selectEnrollment,
    save,
    remove,
    restore,
    failures,
    blocker,
    start: () => assign(),
    edit: (record: ClinicalRecord) => assign(record),
  };
}
