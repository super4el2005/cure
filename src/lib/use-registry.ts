import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";
import { groupRegistrySeries, registryObservations } from "@/src/lib/registry-data";
import { registryParticipantCode } from "@/src/lib/registry-data";
import type { DeidentifiedRegistryRow } from "@/src/lib/registry-data";
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
  // De-identified researcher reading is online-only: the server recomputes
  // enrollment-consent eligibility on every read and nothing is stored
  // locally beyond the live response.
  const convex = useConvex();
  const researcherFeed = useQuery({
    queryKey: ["registry-observations", workspace?.scope, formClientId],
    enabled: Boolean(workspace && opened?.role === "researcher"),
    gcTime: 0,
    networkMode: "always",
    retry: false,
    refetchInterval: 30000,
    queryFn: () =>
      convex.query(api.registries.observations, {
        actorId: userId!,
        organizationId: workspace!.organizationId,
        formClientId,
      }),
  });
  const participantMap = new Map<string, DeidentifiedRegistryRow[]>();
  for (const row of researcherFeed.data?.rows ?? []) {
    const rows = participantMap.get(row.participantCode) ?? [];
    rows.push(row);
    participantMap.set(row.participantCode, rows);
  }
  const researcherSeries = [...participantMap.entries()].map(([participantCode, observations]) => ({
    participantCode,
    observations,
  }));
  const queryClient = useQueryClient();
  const queriesFeed = useQuery({
    queryKey: ["registry-queries", workspace?.scope, formClientId],
    enabled: Boolean(workspace && opened),
    gcTime: 0,
    networkMode: "always",
    retry: false,
    refetchInterval: 30000,
    queryFn: () =>
      convex.query(api.registries.queries, {
        actorId: userId!,
        organizationId: workspace!.organizationId,
        formClientId,
      }),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["registry-queries", workspace?.scope, formClientId],
    });
  const raiseQuery = useMutation({
    mutationKey: ["registry-query-raise"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: {
      participantCode: string;
      occurredOn: string;
      formVersion: number;
      fieldId: string | null;
      text: string;
    }) => {
      if (!workspace || opened?.role !== "researcher") throw new Error("ACCESS_DENIED");
      return convex.mutation(api.registries.raise, {
        actorId: userId!,
        organizationId: workspace.organizationId,
        formClientId,
        clientId: crypto.randomUUID(),
        ...input,
      });
    },
    onSuccess: invalidate,
  });
  const resolveQuery = useMutation({
    mutationKey: ["registry-query-resolve"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: {
      clientId: string;
      status: "resolved" | "dismissed";
      resolution: string;
    }) => {
      if (!workspace || opened?.role !== "doctor") throw new Error("ACCESS_DENIED");
      return convex.mutation(api.registries.resolve, {
        actorId: userId!,
        organizationId: workspace.organizationId,
        ...input,
      });
    },
    onSuccess: invalidate,
  });
  const queryParticipants = new Map(
    series.map((group) => [
      registryParticipantCode(latest?.projectClientId ?? "", group.patientClientId),
      group.patientClientId,
    ]),
  );
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
    researcherFeed,
    researcherSeries,
    queriesFeed,
    raiseQuery,
    resolveQuery,
    queryParticipants,
    canRead: Boolean(workspace && opened?.role === "doctor"),
    loading: Boolean(
      workspace &&
      opened?.role === "doctor" &&
      (!localRecords.isReady || (projects && !localTemplates.isReady)),
    ),
  };
}
