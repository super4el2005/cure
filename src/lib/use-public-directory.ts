import { useSetState } from "@mantine/hooks";
import { useConvex } from "convex/react";
import { useEffect } from "react";

import { openPublicDirectory } from "@/src/lib/public-directory";
import { reportFailure } from "@/src/observability/events";

type Directory = Awaited<ReturnType<typeof openPublicDirectory>>;
export function usePublicDirectory() {
  const client = useConvex();
  const [state, setState] = useSetState<{ directory?: Directory; failed: boolean }>({
    failed: false,
  });
  // A worker, SQLite connection and Convex subscriptions are external resources.
  useEffect(() => {
    const controller = new AbortController();
    let directory: Directory | undefined;
    void openPublicDirectory(client, controller.signal)
      .then(async (opened) => {
        directory = opened;
        if (controller.signal.aborted) await opened.close();
        else setState({ directory: opened, failed: false });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        reportFailure(error, "directory.open", "STORAGE_UNAVAILABLE");
        setState({ failed: true });
      });
    return () => {
      controller.abort();
      void directory?.close().catch((error) => reportFailure(error, "directory.close"));
    };
  }, [client, setState]);
  return state;
}
