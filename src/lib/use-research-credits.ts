import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";

import type { FailedProjectAction } from "@/src/lib/project-workspace";
import {
  creditEventSchema,
  currentAgreement,
  currentDeclaration,
  currentDecision,
} from "@/src/lib/research-credit-model";
import type { CreditEvent } from "@/src/lib/research-credit-model";
import { useProjectWork } from "@/src/lib/use-project-work";

const initial = {
  scope: "",
  projectId: "",
  draftId: "",
  failureId: "",
  kind: "declaration" as CreditEvent["kind"],
  previousClientId: null as string | null,
  roles: [] as Extract<CreditEvent, { kind: "declaration" }>["roles"],
  contribution: "",
  hasInterests: "",
  interests: "",
  groupId: "",
  version: 1,
  outputTitle: "",
  terms: "",
  authors: [] as { userId: string }[],
  correspondingAuthorId: "",
  reason: "",
  agreementClientId: "",
  declarationClientId: "",
  decision: "",
  comment: "",
  attestations: {
    substantialContribution: false,
    manuscriptWork: false,
    finalApproval: false,
    accountability: false,
  },
};
function event(values: typeof initial) {
  if (values.kind === "declaration")
    return {
      kind: values.kind,
      previousClientId: values.previousClientId,
      roles: values.roles,
      contribution: values.contribution,
      hasInterests:
        values.hasInterests === "yes" ? true : values.hasInterests === "no" ? false : undefined,
      interests: values.interests,
    };
  if (values.kind === "agreement")
    return {
      kind: values.kind,
      previousClientId: values.previousClientId,
      groupId: values.groupId,
      version: values.version,
      outputTitle: values.outputTitle,
      terms: values.terms,
      authors: values.authors.map((row) => row.userId),
      correspondingAuthorId: values.correspondingAuthorId,
      reason: values.reason,
    };
  return {
    kind: values.kind,
    previousClientId: values.previousClientId,
    agreementClientId: values.agreementClientId,
    declarationClientId: values.declarationClientId,
    decision: values.decision,
    comment: values.comment,
    attestations: values.attestations,
  };
}
export function useResearchCredits(projectId: string) {
  const space = useProjectWork();
  const { workspace, userId, rows, workRecords, status } = space;
  const { t } = useLingui();
  const project = rows.find((row) => row.clientId === projectId);
  const entries = workRecords
    .filter((row) => row.entity === "credit")
    .filter((row) => row.projectClientId === projectId);
  const agreementGroups = [
    ...new Set(
      entries.flatMap((row) => (row.values.kind === "agreement" ? [row.values.groupId] : [])),
    ),
  ];
  const agreements = agreementGroups.flatMap((group) => {
    const row = currentAgreement(entries, group);
    return row ? [row] : [];
  });
  const members = space.records
    .filter((row) => row.entity === "member")
    .filter((row) => row.projectClientId === projectId);
  const names = new Map(members.map((row) => [row.userId, row.displayName || row.userId]));
  const canWrite = Boolean(
    workspace?.canWrite() &&
    project &&
    project.selfRole !== "viewer" &&
    project.status !== "archived",
  );
  const manager = Boolean(project && ["owner", "coordinator"].includes(project.selfRole));
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (values) => {
      const result = creditEventSchema.safeParse(event(values));
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
          );
    },
  });
  const begin = (value?: CreditEvent, failureId = "") => {
    if (!workspace) return;
    let next = {
      ...initial,
      scope: workspace.scope,
      projectId,
      draftId: crypto.randomUUID(),
      failureId,
    };
    if (!value || value.kind === "declaration") {
      const latest = currentDeclaration(entries, userId!);
      const source = value ?? (latest?.values.kind === "declaration" ? latest.values : undefined);
      next = {
        ...next,
        kind: "declaration",
        previousClientId: latest?.clientId ?? null,
        ...(source?.kind === "declaration"
          ? {
              roles: source.roles,
              contribution: source.contribution,
              hasInterests: source.hasInterests ? "yes" : "no",
              interests: source.interests,
            }
          : {}),
      };
    } else if (value.kind === "agreement") {
      const latest = currentAgreement(entries, value.groupId);
      next = {
        ...next,
        ...value,
        previousClientId: latest?.clientId ?? null,
        version: latest?.values.kind === "agreement" ? latest.values.version + 1 : 1,
        authors: value.authors.map((userId) => ({ userId })),
        reason: failureId ? value.reason : "",
      };
    } else {
      next = { ...next, ...value };
    }
    const baseline = failureId ? { ...initial, scope: workspace.scope, projectId } : next;
    form.setInitialValues(baseline);
    form.setValues(next);
    form.resetDirty(baseline);
    form.clearErrors();
    editor.open();
  };
  const newAgreement = () =>
    begin({
      kind: "agreement",
      groupId: crypto.randomUUID(),
      previousClientId: null,
      version: 1,
      outputTitle: "",
      terms: "",
      authors: [userId!],
      correspondingAuthorId: userId!,
      reason: "",
    });
  const decide = (agreementClientId: string) => {
    const declaration = currentDeclaration(entries, userId!);
    const previous = currentDecision(entries, agreementClientId, userId!);
    begin({
      kind: "decision",
      agreementClientId,
      declarationClientId: declaration?.clientId ?? "",
      previousClientId: previous?.clientId ?? null,
      decision: "declined",
      comment: "",
      attestations: { ...initial.attestations },
    });
    form.setFieldValue("decision", "");
  };
  const failures = useQuery({
    queryKey: ["credit-failures", workspace?.scope, projectId],
    enabled: Boolean(workspace),
    networkMode: "always",
    gcTime: 0,
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("credit")).filter(
        (row) => workspace!.readWork(row.envelope).projectClientId === projectId,
      ),
  });
  const saveCredit = useMutation({
    mutationKey: ["credit-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (values: typeof initial) => {
      if (!workspace || values.scope !== workspace.scope || values.projectId !== projectId)
        throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveWork({
        entity: "credit",
        clientId: crypto.randomUUID(),
        projectClientId: projectId,
        expectedRevision: 0,
        values: creditEventSchema.parse(event(values)),
      });
      if (values.failureId) await workspace.dismissFailure(values.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (form.getValues().draftId === input.draftId) {
        form.setValues(initial);
        form.setInitialValues(initial);
        form.resetDirty(initial);
        editor.close();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["credit-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedProjectAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.readWork(failure.envelope);
      if (row.entity !== "credit") throw new Error("INVALID_RESEARCH_CREDIT");
      begin(row.values, failure.id);
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
    project,
    entries,
    agreements,
    members,
    names,
    canWrite,
    manager,
    editing,
    editor,
    form,
    begin,
    newAgreement,
    decide,
    failures,
    saveCredit,
    restore,
    blocker,
  };
}
