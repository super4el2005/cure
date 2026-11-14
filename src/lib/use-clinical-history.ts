import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

export function useClinicalHistory(patientId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status } = space;
  const convex = useConvex();
  const cardVersions = useLiveQuery(() => workspace?.patientVersions);
  const versions = useLiveQuery(() => workspace?.clinicalVersions);
  const current = useLiveQuery(() => workspace?.clinicalRecords);
  const patients = useLiveQuery(() => workspace?.collection);
  const allowed = workspace && opened?.role === "doctor" && Date.now() < workspace.expiresAt;
  const cardHistory = allowed
    ? (cardVersions.data ?? [])
        .filter((row) => row.clientId !== workspace.patientVersionSnapshotId)
        .flatMap((row) => {
          try {
            const record = workspace.readPatientVersion(row);
            return record.patientClientId === patientId ? [record] : [];
          } catch (error) {
            if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
            throw error;
          }
        })
        .sort((a, b) => b.revision - a.revision)
    : [];
  const history = allowed
    ? (versions.data ?? [])
        .filter((row) => row.clientId !== workspace.versionSnapshotId)
        .flatMap((row) => {
          try {
            const record = workspace.readClinicalVersion(row);
            return record.patientClientId === patientId ? [record] : [];
          } catch (error) {
            if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
            throw error;
          }
        })
        .sort((a, b) => b.recordedAt - a.recordedAt || b.revision - a.revision)
    : [];
  const unarchived = allowed
    ? (current.data ?? [])
        .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
        .flatMap((row) => {
          try {
            const record = workspace.readClinical(row);
            return record.patientClientId === patientId &&
              !history.some(
                (version) =>
                  version.recordClientId === record.clientId &&
                  version.revision === record.revision,
              )
              ? [record]
              : [];
          } catch (error) {
            if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
            throw error;
          }
        })
    : [];
  const reviewers = useQuery({
    queryKey: ["clinical-history-reviewers", workspace?.scope, status.data?.online],
    enabled: Boolean(allowed),
    networkMode: "always",
    gcTime: 0,
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
  const names = new Map(
    [...(reviewers.data ?? []), ...(space.researchers.data ?? [])].map((row) => [
      row.userId,
      row.displayName,
    ]),
  );
  return {
    ...space,
    cardVersions,
    cardHistory,
    versions,
    current,
    patients,
    history,
    unarchived,
    names,
    reviewers,
  };
}
