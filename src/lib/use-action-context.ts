import { useMemo, useRef } from "react";

import { createActionJournal } from "@/src/lib/action-journal";
import type { ActionJournalEntry } from "@/src/lib/action-registry";
import type { ActionContext } from "@/src/lib/action-registry";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

// Shared context preparation for agent-facing entry points (WebMCP, chat).
// The getter decrypts the live collections at call time, so consumers
// always act on current data within the current workspace session.
export function useActionContext() {
  const space = usePatientWorkspace();
  const { workspace, opened } = space;
  const journal = useRef<{ record: (entry: ActionJournalEntry) => void } | null>(null);
  const sessionJournal = useMemo(() => {
    if (!workspace || Date.now() >= workspace.expiresAt) return null;
    return createActionJournal();
  }, [workspace]);
  journal.current = sessionJournal;
  const ready = Boolean(workspace && opened && space.userId && sessionJournal);
  const getContext = (): ActionContext => {
    if (!workspace || !opened || !sessionJournal) throw new Error("WORKSPACE_LOCKED");
    if (Date.now() >= workspace.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
    const rows = Array.from(workspace.collection.values())
      .filter((row) => !row.deleted && row.clientId !== workspace.patientSnapshotId)
      .flatMap((envelope) => {
        try {
          return [workspace.read(envelope)];
        } catch (error) {
          if (error instanceof Error && error.message === "ACCESS_DENIED") return [];
          throw error;
        }
      });
    const clinicalRows =
      opened.role !== "doctor"
        ? []
        : Array.from(workspace.clinicalRecords.values())
            .filter((row) => !row.deleted && row.clientId !== workspace.clinicalSnapshotId)
            .flatMap((envelope) => {
              try {
                return [workspace.readClinical(envelope)];
              } catch (error) {
                if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
                throw error;
              }
            });
    const analyses = Array.from(workspace.analyses.values())
      .filter((row) => !row.deleted && row.clientId !== workspace.analysisSnapshotId)
      .map((envelope) => workspace.readAnalysis(envelope));
    return {
      workspace,
      rows,
      clinicalRows,
      analyses,
      role: opened.role,
      now: Date.now(),
      journal: sessionJournal,
    };
  };
  return { getContext, journal, ready, role: opened?.role ?? null, userId: space.userId };
}
