import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useConvex } from "convex/react";

import { api } from "@/convex/_generated/api";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

export function useClinicalHistory(patientId: string, includeVersions = true) {
  const space = usePatientWorkspace();
  const { workspace, opened, userId, status } = space;
  const convex = useConvex();
  const cardVersions = useLiveQuery(() =>
    includeVersions ? workspace?.patientVersions : undefined,
  );
  const versions = useLiveQuery(() => (includeVersions ? workspace?.clinicalVersions : undefined));
  const current = useLiveQuery(() => workspace?.clinicalRecords);
  const patients = useLiveQuery(() => workspace?.collection);
  const allowed = workspace && opened?.role === "doctor" && Date.now() < workspace.expiresAt;
  const cardHistory =
    allowed && includeVersions
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
  const history =
    allowed && includeVersions
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
  const records = allowed
    ? (current.data ?? [])
        .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
        .flatMap((row) => {
          try {
            const record = workspace.readClinical(row);
            return record.patientClientId === patientId ? [record] : [];
          } catch (error) {
            if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
            throw error;
          }
        })
    : [];
  const unarchived = records.filter(
    (record) =>
      !history.some(
        (version) =>
          version.recordClientId === record.clientId && version.revision === record.revision,
      ),
  );
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
    records,
    names,
    reviewers,
  };
}
