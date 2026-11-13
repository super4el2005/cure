import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";

import type { FailedProjectAction } from "@/src/lib/project-workspace";
import { formDefinitionSchema } from "@/src/lib/study-form-model";
import type { StudyField, FormVersion } from "@/src/lib/study-form-model";
import { useProjectWorkspace } from "@/src/lib/use-project-workspace";

export const newStudyField = () => ({
  id: crypto.randomUUID() as string,
  type: "text" as StudyField["type"],
  label: "",
  help: "",
  required: false,
  maxLength: 1000 as number | string,
  minimum: null as number | string | null,
  maximum: null as number | string | null,
  unit: "",
  minDate: "",
  maxDate: "",
  choices: [{ value: crypto.randomUUID() as string, label: "" }],
});
const initial = {
  scope: "",
  projectClientId: "",
  formClientId: "",
  expectedVersion: 0,
  baseVersionClientId: null as string | null,
  failureId: "",
  status: "published" as FormVersion["status"],
  title: "",
  description: "",
  fields: [] as ReturnType<typeof newStudyField>[],
};
export function useStudyForms(projectId: string) {
  const space = useProjectWorkspace();
  const { workspace, rows, status } = space;
  const { t } = useLingui();
  const localForms = useLiveQuery(() => workspace?.forms);
  const project = rows.find((row) => row.clientId === projectId);
  const history =
    workspace && project
      ? (localForms.data ?? [])
          .filter((row) => row.clientId !== workspace.formSnapshotId)
          .map(workspace.readForm)
          .filter((row) => row.projectClientId === projectId)
          .sort((a, b) => b.version - a.version || b.createdAt - a.createdAt)
      : [];
  const latest = [
    ...new Map([...history].reverse().map((row) => [row.formClientId, row])).values(),
  ];
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (values) => {
      const result = formDefinitionSchema.safeParse(values);
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
    },
  });
  const assign = (record?: FormVersion, failureId = "") => {
    if (!workspace) return;
    const values = {
      ...initial,
      scope: workspace.scope,
      projectClientId: projectId,
      formClientId: record?.formClientId ?? crypto.randomUUID(),
      expectedVersion: record
        ? (latest.find((row) => row.formClientId === record.formClientId)?.version ?? 0)
        : 0,
      baseVersionClientId: record
        ? (latest.find((row) => row.formClientId === record.formClientId)?.clientId ?? null)
        : null,
      failureId,
      status: record?.status ?? "published",
      title: record?.definition.title ?? "",
      description: record?.definition.description ?? "",
      fields: record
        ? record.definition.fields.map((field) => ({ ...newStudyField(), ...field }))
        : [newStudyField()],
    };
    form.setInitialValues(values);
    form.setValues(values);
    form.resetDirty(values);
    form.clearErrors();
    editor.open();
  };
  const failures = useQuery({
    queryKey: ["form-failures", workspace?.scope, projectId],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("form")).filter(
        (failure) => workspace!.readForm(failure.envelope).projectClientId === projectId,
      ),
  });
  const saveForm = useMutation({
    mutationKey: ["form-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (values: typeof initial) => {
      if (!workspace || values.scope !== workspace.scope || values.projectClientId !== projectId)
        throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveForm({
        clientId: crypto.randomUUID(),
        projectClientId: values.projectClientId,
        formClientId: values.formClientId,
        expectedVersion: values.expectedVersion,
        baseVersionClientId: values.baseVersionClientId,
        definition: formDefinitionSchema.parse(values),
        status: values.status,
      });
      if (values.failureId) await workspace.dismissFailure(values.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      const current = form.getValues();
      if (
        current.scope === input.scope &&
        current.projectClientId === input.projectClientId &&
        current.formClientId === input.formClientId &&
        current.expectedVersion === input.expectedVersion
      ) {
        editor.close();
        form.reset();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["form-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      assign(workspace.readForm(failure.envelope), failure.id);
    },
  });
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: () =>
      editing &&
      Boolean(workspace) &&
      form.values.scope === workspace?.scope &&
      form.values.projectClientId === projectId &&
      form.isDirty(),
    enableBeforeUnload: () =>
      editing &&
      Boolean(workspace) &&
      form.values.scope === workspace?.scope &&
      form.values.projectClientId === projectId &&
      form.isDirty(),
  });
  return {
    ...space,
    blocker,
    localForms,
    project,
    history,
    latest,
    editing,
    editor,
    form,
    saveForm,
    failures,
    restore,
    newForm: () => assign(),
    newVersion: (record: FormVersion) => assign(record),
    canEdit: Boolean(
      workspace?.canWrite() &&
      project &&
      ["owner", "coordinator"].includes(project.selfRole) &&
      !["completed", "archived"].includes(project.status) &&
      localForms.isReady,
    ),
  };
}
