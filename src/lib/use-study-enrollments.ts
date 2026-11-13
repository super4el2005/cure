import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";

import type { ClinicalRecord } from "@/src/lib/clinical-record-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { retainedWorkspaceOptions } from "@/src/lib/retained-workspaces";
import { enrollmentEventSchema, enrollmentTransitions } from "@/src/lib/study-enrollment-model";
import type { EnrollmentPayload, EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

const initial = {
  scope: "",
  patientClientId: "",
  clientId: "",
  expectedRevision: 0,
  failureId: "",
  previous: null as EnrollmentPayload | null,
  protocolClientId: "",
  status: "screening" as EnrollmentStatus,
  occurredOn: "",
  reason: "",
  eligibilityEvidence: "",
  inclusionConfirmed: false,
  exclusionAbsent: false,
  documentReference: "",
  consentVersion: "",
  signedOn: null as string | null,
  expiresOn: null as string | null,
};
function event(input: typeof initial, actorId: string) {
  return enrollmentEventSchema.parse({
    id: crypto.randomUUID(),
    status: input.status,
    occurredOn: input.occurredOn,
    reason: input.reason,
    recordedAt: Date.now(),
    recordedBy: actorId,
    eligibilityEvidence: input.eligibilityEvidence,
    inclusionConfirmed: input.inclusionConfirmed,
    exclusionAbsent: input.exclusionAbsent,
    consent:
      input.status === "enrolled"
        ? {
            documentReference: input.documentReference,
            version: input.consentVersion,
            signedOn: input.signedOn,
            expiresOn: input.expiresOn,
          }
        : null,
  });
}
export function useStudyEnrollments(patientId: string) {
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
  const projectSource = useLiveQuery(() => projects?.collection);
  const protocolSource = useLiveQuery(() => projects?.protocols);
  const projectRows = projects
    ? (projectSource.data ?? [])
        .filter((row) => row.clientId !== projects.projectSnapshotId)
        .map(projects.read)
    : [];
  const projectMap = new Map(projectRows.map((row) => [row.clientId, row]));
  const protocols = projects
    ? (protocolSource.data ?? [])
        .filter((row) => row.clientId !== projects.protocolSnapshotId)
        .map(projects.readProtocol)
    : [];
  const latest = new Map<string, (typeof protocols)[number]>();
  for (const protocol of protocols)
    if ((latest.get(protocol.projectClientId)?.version ?? 0) < protocol.version)
      latest.set(protocol.projectClientId, protocol);
  const available = [...latest.values()].filter(
    (row) =>
      row.confirmed &&
      row.ethicsApproved &&
      row.ethicsExpiresAt > Date.now() &&
      projectMap.get(row.projectClientId)?.status === "recruiting" &&
      projectMap.get(row.projectClientId)?.selfRole !== "viewer",
  );
  const source = useLiveQuery(() => workspace?.clinicalRecords);
  const records =
    workspace && opened?.role === "doctor"
      ? (source.data ?? [])
          .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              const row = workspace.readClinical(envelope);
              return row.patientClientId === patientId && row.payload?.kind === "enrollment"
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
      try {
        event(input, userId ?? "");
        return !input.previous && !input.protocolClientId
          ? { protocolClientId: t`Выберите протокол` }
          : {};
      } catch {
        return { reason: t`Проверьте дату, причину, критерии и реквизиты согласия` };
      }
    },
  });
  const assign = (record?: ClinicalRecord, failureId = "") => {
    if (!workspace) return;
    const proposed = record?.payload?.kind === "enrollment" ? record.payload : null;
    const envelope = record ? workspace.clinicalRecords.get(record.clientId) : undefined;
    const current =
      failureId && envelope && !envelope.deleted ? workspace.readClinical(envelope) : record;
    const previous = failureId
      ? current?.payload?.kind === "enrollment" && envelope && !envelope.deleted
        ? current.payload
        : null
      : proposed;
    const rejected = failureId ? proposed?.events.at(-1) : undefined;
    const previousStatus = previous?.events.at(-1)?.status;
    const values = {
      ...initial,
      scope: workspace.scope,
      patientClientId: patientId,
      clientId: previous ? current!.clientId : "",
      expectedRevision: previous ? current!.revision : 0,
      failureId,
      previous,
      protocolClientId: proposed?.protocolClientId ?? "",
      status:
        rejected?.status ??
        (previousStatus
          ? (enrollmentTransitions[previousStatus][0] ?? previousStatus)
          : "screening"),
      occurredOn: rejected?.occurredOn ?? new Date().toISOString().slice(0, 10),
      reason: rejected?.reason ?? "",
      eligibilityEvidence: rejected?.eligibilityEvidence ?? "",
      inclusionConfirmed: rejected?.inclusionConfirmed ?? false,
      exclusionAbsent: rejected?.exclusionAbsent ?? false,
      documentReference: rejected?.consent?.documentReference ?? "",
      consentVersion: rejected?.consent?.version ?? "",
      signedOn: rejected?.consent?.signedOn ?? null,
      expiresOn: rejected?.consent?.expiresOn ?? null,
    };
    form.setInitialValues(values);
    form.setValues(values);
    form.resetDirty(values);
    form.clearErrors();
    editor.open();
  };
  const failures = useQuery({
    queryKey: ["enrollment-failures", workspace?.scope, patientId],
    enabled: Boolean(workspace && opened?.role === "doctor"),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("clinical")).filter((failure) => {
        try {
          const row = workspace!.readClinical(failure.envelope);
          return row.patientClientId === patientId && row.payload?.kind === "enrollment";
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return false;
          throw error;
        }
      }),
  });
  const save = useMutation({
    mutationKey: ["enrollment-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope || input.patientClientId !== patientId)
        throw new Error("WORKSPACE_LOCKED");
      if (opened?.role !== "doctor") throw new Error("ACCESS_DENIED");
      const next = event(input, userId!);
      const protocol = available.find(
        (row) => row.clientId === (input.previous?.protocolClientId ?? input.protocolClientId),
      );
      if ((!input.previous || next.status === "enrolled") && !protocol)
        throw new Error("RECRUITMENT_CLOSED");
      const payload: EnrollmentPayload = input.previous
        ? {
            ...input.previous,
            writeId: crypto.randomUUID(),
            events: [...input.previous.events, next],
          }
        : {
            kind: "enrollment",
            writeId: crypto.randomUUID(),
            occurredOn: next.occurredOn,
            notes: "",
            projectClientId: protocol!.projectClientId,
            protocolClientId: protocol!.clientId,
            protocolVersion: protocol!.version,
            events: [next],
          };
      const result = await workspace.saveClinical({
        clientId: input.clientId || crypto.randomUUID(),
        patientClientId: patientId,
        expectedRevision: input.expectedRevision,
        action: input.clientId ? "update" : "create",
        payload,
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
        editor.close();
        form.reset();
      }
      void status.refetch();
      void failures.refetch();
    },
  });
  const remove = useMutation({
    mutationKey: ["enrollment-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (record: ClinicalRecord) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveClinical({
        clientId: record.clientId,
        patientClientId: record.patientClientId,
        expectedRevision: record.revision,
        action: "delete",
      });
    },
    onSuccess: () => {
      void status.refetch();
      void failures.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["enrollment-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      if (failure.action === "delete") throw new Error("INVALID_ENROLLMENT");
      assign(workspace.readClinical(failure.envelope), failure.id);
    },
  });
  const dirty = () =>
    editing &&
    Boolean(workspace) &&
    form.values.scope === workspace?.scope &&
    form.values.patientClientId === patientId &&
    form.isDirty();
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: dirty,
    enableBeforeUnload: dirty,
  });
  return {
    ...space,
    projects,
    projectMap,
    protocols,
    protocolSource,
    available,
    source,
    records,
    editing,
    editor,
    form,
    save,
    remove,
    restore,
    failures,
    blocker,
    start: () => assign(),
    advance: (record: ClinicalRecord) => assign(record),
  };
}
