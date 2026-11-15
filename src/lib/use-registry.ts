import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";

import { groupRegistrySeries, registryObservations } from "@/src/lib/registry-data";
import { retainedWorkspaceOptions } from "@/src/lib/retained-workspaces";
import type { FormVersion } from "@/src/lib/study-form-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

export function useRegistry(formClientId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status, rows } = space;
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
  const family = projects
    ? (localTemplates.data ?? [])
        .filter((row) => row.clientId !== projects.formSnapshotId)
        .map(projects.readForm)
        .filter(
          (row): row is FormVersion & { definition: NonNullable<FormVersion["definition"]> } =>
            row.formClientId === formClientId && projectMap.has(row.projectClientId),
        )
        .sort((a, b) => b.version - a.version || b.createdAt - a.createdAt)
    : [];
  const latest = family[0];
  const registry = latest?.definition.registry;
  const project = latest ? projectMap.get(latest.projectClientId) : undefined;
  const localRecords = useLiveQuery(() => workspace?.clinicalRecords);
  const records =
    workspace && opened?.role === "doctor"
      ? (localRecords.data ?? [])
          .filter((row) => row.clientId !== workspace.clinicalSnapshotId)
          .flatMap((envelope) => {
            try {
              return [workspace.readClinical(envelope)];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          })
      : [];
  const observations = registryObservations(records, formClientId);
  const series = groupRegistrySeries(observations);
  const names = new Map(rows.map((row) => [row.clientId, row.fullName]));
  return {
    ...space,
    localTemplates,
    localProjects,
    localRecords,
    family,
    latest,
    registry,
    project,
    observations,
    series,
    names,
    canRead: Boolean(workspace && opened?.role === "doctor"),
    loading: Boolean(
      workspace &&
      opened?.role === "doctor" &&
      (!localRecords.isReady || (projects && !localTemplates.isReady)),
    ),
  };
}
