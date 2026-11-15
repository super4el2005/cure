import { useEffect, useRef } from "react";

import { createActionJournal } from "@/src/lib/action-journal";
import type { ActionJournalEntry } from "@/src/lib/action-registry";
import type { ActionContext } from "@/src/lib/action-registry";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";
import { registerWebMcpTools } from "@/src/lib/webmcp";
import { buildWebMcpTools } from "@/src/lib/webmcp-actions";

// Exposes the unified read actions as WebMCP tools while a patient
// workspace is open. Tool closures decrypt the live collections at call
// time, so registration happens once per workspace, not per data change.
export function useWebMcpActions() {
  const space = usePatientWorkspace();
  const { workspace, opened } = space;
  const journal = useRef<{ record: (entry: ActionJournalEntry) => void } | null>(null);
  useEffect(() => {
    if (!workspace || !opened || !space.userId || Date.now() >= workspace.expiresAt) return;
    const sessionJournal = createActionJournal();
    journal.current = sessionJournal;
    const controller = new AbortController();
    const getContext = (): ActionContext => {
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
    registerWebMcpTools(buildWebMcpTools(getContext, { userId: space.userId }), controller.signal);
    return () => {
      controller.abort();
      journal.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, opened?.role, space.userId]);
  return { webmcpJournal: journal };
}
