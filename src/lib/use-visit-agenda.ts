import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";

import { retainedWorkspaceOptions } from "@/src/lib/retained-workspaces";
import { visitTime } from "@/src/lib/visit-time";

// Only observe an already unlocked workspace; the overview never unlocks or
// opens a second clinical store, and never reads under a different actor.
export function useVisitAgenda(userId: string | undefined) {
  const retained = useQuery(retainedWorkspaceOptions);
  const entry = retained.data.find((item) => item.kind === "patients" && item.userId === userId);
  const workspace =
    entry?.kind === "patients" &&
    entry.workspace.role === "doctor" &&
    Date.now() < entry.workspace.expiresAt
      ? entry.workspace
      : undefined;
  const clinical = useLiveQuery(() => workspace?.clinicalRecords);
  const patients = useLiveQuery(() => workspace?.collection);
  const visits = workspace
    ? (clinical.data ?? [])
        .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
        .flatMap((row) => {
          try {
            const record = workspace.readClinical(row);
            const payload = record.payload;
            if (
              (payload?.kind !== "visit" && payload?.kind !== "studyVisit") ||
              !["planned", "inProgress"].includes(payload.status)
            )
              return [];
            const patient = workspace.collection.get(record.patientClientId);
            if (!patient || patient.deleted) return [];
            return [
              {
                record,
                payload,
                patientName: workspace.read(patient).fullName,
                time: visitTime(payload.scheduledFor),
              },
            ];
          } catch (error) {
            if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
            throw error;
          }
        })
        .sort((a, b) => a.time.epoch - b.time.epoch)
    : [];
  return { workspace, visits, ready: clinical.isReady && patients.isReady };
}
