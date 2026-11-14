import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import dayjs from "dayjs";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { retainedWorkspaceOptions } from "@/src/lib/retained-workspaces";
import { normalizeFormAnswers, questionnairePayloadSchema } from "@/src/lib/study-form-model";
import type { FormVersion, QuestionnairePayload } from "@/src/lib/study-form-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

type Template = Pick<
  FormVersion,
  "clientId" | "formClientId" | "projectClientId" | "version" | "definition"
>;
const initial = {
  scope: "",
  patientClientId: "",
  clientId: "",
  expectedRevision: 0,
  expectedHistoryId: null as string | null,
  failureId: "",
  template: null as Template | null,
  occurredOn: null as string | null,
  status: "draft" as "draft" | "final",
  originalStatus: "draft" as "draft" | "final",
  answers: {} as Record<string, string | number | string[]>,
  notes: "",
  amendmentReason: "",
};
function payload(input: typeof initial) {
  if (!input.template) throw new Error("INVALID_STUDY_FORM");
  return {
    kind: "questionnaire" as const,
    writeId: crypto.randomUUID(),
    occurredOn: input.occurredOn ?? "",
    notes: input.notes,
    projectClientId: input.template.projectClientId,
    formClientId: input.template.formClientId,
    formVersionClientId: input.template.clientId,
    formVersion: input.template.version,
    definition: input.template.definition,
    answers: normalizeFormAnswers(input.template.definition, input.answers),
    status: input.status,
    amendmentReason: input.amendmentReason,
  };
}
export function useQuestionnaires(patientId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status } = space;
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
  const localProjects = useLiveQuery(() => projects?.collection);
  const localTemplates = useLiveQuery(() => projects?.forms);
  const projectRows = projects
    ? (localProjects.data ?? [])
        .filter((row) => row.clientId !== projects.projectSnapshotId)
        .map(projects.read)
    : [];
  const projectMap = new Map(projectRows.map((row) => [row.clientId, row]));
  const templates = projects
    ? (localTemplates.data ?? [])
        .filter((row) => row.clientId !== projects.formSnapshotId)
        .map(projects.readForm)
        .filter((row) => projectMap.has(row.projectClientId))
    : [];
  const families = new Map<string, FormVersion>();
  for (const row of templates) {
    const key = `${row.projectClientId}:${row.formClientId}`;
    if ((families.get(key)?.version ?? 0) < row.version) families.set(key, row);
  }
  const availableTemplates = [...families.values()].filter(
    (row) =>
      row.status === "published" &&
      row.confirmed &&
      !["completed", "archived"].includes(projectMap.get(row.projectClientId)!.status) &&
      projectMap.get(row.projectClientId)!.selfRole !== "viewer",
  );
  const localResponses = useLiveQuery(() => workspace?.clinicalRecords);
  const responses =
    workspace && opened?.role === "doctor"
      ? (localResponses.data ?? [])
          .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              const row = workspace.readClinical(envelope);
              return row.patientClientId === patientId && row.payload?.kind === "questionnaire"
                ? [row]
                : [];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (input) => {
      if (!input.template) return { template: t`Выберите шаблон` };
      const result = questionnairePayloadSchema.safeParse(payload(input));
      const errors = result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
      return {
        ...errors,
        ...(input.originalStatus === "final" && !input.amendmentReason.trim()
          ? { amendmentReason: t`Укажите причину исправления окончательного ответа` }
          : {}),
      };
    },
  });
  const assign = (record?: ClinicalRecord, failureId = "") => {
    if (!workspace) return;
    const value = record?.payload?.kind === "questionnaire" ? record.payload : undefined;
    const current = record ? workspace.clinicalRecords.get(record.clientId) : undefined;
    const values = {
      ...initial,
      scope: workspace.scope,
      patientClientId: patientId,
      clientId: record && (!failureId || (current && !current.deleted)) ? record.clientId : "",
      expectedRevision: record
        ? failureId
          ? current && !current.deleted
            ? current.revision
            : 0
          : record.revision
        : 0,
      expectedHistoryId: record
        ? failureId
          ? current && !current.deleted
            ? (workspace.readClinical(current).historyId ?? null)
            : null
          : (record.historyId ?? null)
        : null,
      failureId,
      template: value
        ? {
            clientId: value.formVersionClientId,
            formClientId: value.formClientId,
            projectClientId: value.projectClientId,
            version: value.formVersion,
            definition: value.definition,
          }
        : null,
      occurredOn: value?.occurredOn ?? dayjs().format("YYYY-MM-DD"),
      status: value?.status ?? "draft",
      originalStatus: value?.status ?? "draft",
      notes: value?.notes ?? "",
      amendmentReason: failureId ? (value?.amendmentReason ?? "") : "",
      answers: Object.fromEntries(
        (value?.definition.fields ?? []).map((field) => {
          const answer = value?.answers[field.id];
          return [
            field.id,
            typeof answer === "boolean"
              ? String(answer)
              : (answer ?? (field.type === "multiChoice" ? [] : "")),
          ];
        }),
      ),
    };
    form.setInitialValues(values);
    form.setValues(values);
    form.resetDirty(values);
    form.clearErrors();
    editor.open();
  };
  const selectTemplate = useMutation({
    mutationKey: ["questionnaire-select"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (clientId: string) => {
      const template = availableTemplates.find((row) => row.clientId === clientId);
      if (!template || !workspace) throw new Error("FORM_VERSION_OUTDATED");
      const values = {
        ...form.getValues(),
        scope: workspace.scope,
        patientClientId: patientId,
        template,
        answers: Object.fromEntries(
          template.definition.fields.map((field) => [
            field.id,
            field.type === "multiChoice" ? [] : "",
          ]),
        ),
      };
      form.setValues(values);
      form.clearErrors();
    },
  });
  const failures = useQuery({
    queryKey: ["questionnaire-failures", workspace?.scope, patientId],
    enabled: Boolean(workspace && opened?.role === "doctor"),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("clinical")).filter((failure) => {
        try {
          const row = workspace!.readClinical(failure.envelope);
          return row.patientClientId === patientId && row.payload?.kind === "questionnaire";
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return false;
          throw error;
        }
      }),
  });
  const canEditResponse = (_value: QuestionnairePayload) =>
    Boolean(workspace && opened?.role === "doctor");
  const saveResponse = useMutation({
    mutationKey: ["questionnaire-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope || input.patientClientId !== patientId)
        throw new Error("WORKSPACE_LOCKED");
      const parsed = questionnairePayloadSchema.parse(payload(input));
      if (!canEditResponse(parsed)) throw new Error("ACCESS_DENIED");
      if (
        !input.clientId &&
        !availableTemplates.some((row) => row.clientId === parsed.formVersionClientId)
      )
        throw new Error("FORM_VERSION_OUTDATED");
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
      const current = form.getValues();
      if (
        current.scope === input.scope &&
        current.patientClientId === input.patientClientId &&
        current.clientId === input.clientId &&
        current.expectedRevision === input.expectedRevision &&
        current.expectedHistoryId === input.expectedHistoryId
      ) {
        form.reset();
        editor.close();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const removeResponse = useMutation({
    mutationKey: ["questionnaire-delete"],
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
    mutationKey: ["questionnaire-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      if (failure.action === "delete") throw new Error("INVALID_CLINICAL_RECORD");
      assign(workspace.readClinical(failure.envelope), failure.id);
    },
  });
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: () =>
      editing &&
      Boolean(workspace) &&
      form.values.scope === workspace?.scope &&
      form.values.patientClientId === patientId &&
      form.isDirty(),
    enableBeforeUnload: () =>
      editing &&
      Boolean(workspace) &&
      form.values.scope === workspace?.scope &&
      form.values.patientClientId === patientId &&
      form.isDirty(),
  });
  return {
    ...space,
    blocker,
    projects,
    projectMap,
    localTemplates,
    localProjects,
    availableTemplates,
    pendingTemplatesCount: [...families.values()].filter(
      (row) => row.status === "published" && !row.confirmed,
    ).length,
    localResponses,
    responses,
    editing,
    editor,
    form,
    selectTemplate,
    saveResponse,
    removeResponse,
    failures,
    restore,
    newResponse: () => assign(),
    editResponse: (record: ClinicalRecord) => assign(record),
    canEditResponse,
  };
}
