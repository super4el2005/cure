import { useSetState } from "@mantine/hooks";
import { useConvex } from "convex/react";
import { useEffect } from "react";

import type { PublicSelection } from "@/src/lib/public-directory";
import { openPublicDirectory } from "@/src/lib/public-directory";
import { reportFailure } from "@/src/observability/events";

type Directory = Awaited<ReturnType<typeof openPublicDirectory>>;
export function usePublicDirectory({
  researchId,
  specialistId,
  organizationId,
}: PublicSelection = {}) {
  const client = useConvex();
  const selectionKey = JSON.stringify([
    researchId ?? null,
    specialistId ?? null,
    organizationId ?? null,
  ]);
  const [state, setState] = useSetState<{
    directory: Directory | undefined;
    key: string;
    failed: boolean;
  }>({ directory: undefined, key: "", failed: false });
  // A worker, SQLite connection and Convex subscriptions are external resources.
  useEffect(() => {
    const controller = new AbortController();
    let directory: Directory | undefined;
    void openPublicDirectory(client, controller.signal, {
      ...(researchId ? { researchId } : {}),
      ...(specialistId ? { specialistId } : {}),
      ...(organizationId ? { organizationId } : {}),
    })
      .then(async (opened) => {
        directory = opened;
        if (controller.signal.aborted) await opened.close();
        else setState({ directory: opened, key: selectionKey, failed: false });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        reportFailure(error, "directory.open", "STORAGE_UNAVAILABLE");
        setState({ directory: undefined, key: selectionKey, failed: true });
      });
    return () => {
      controller.abort();
      void directory?.close().catch((error) => reportFailure(error, "directory.close"));
    };
  }, [client, setState, researchId, specialistId, organizationId, selectionKey]);
  return {
    directory: state.key === selectionKey ? state.directory : undefined,
    failed: state.key === selectionKey && state.failed,
  };
}
