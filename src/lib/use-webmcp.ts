import { useEffect } from "react";

import { useActionContext } from "@/src/lib/use-action-context";
import { registerWebMcpTools } from "@/src/lib/webmcp";
import { buildWebMcpTools } from "@/src/lib/webmcp-actions";

// Exposes the unified read actions as WebMCP tools while a patient
// workspace is open. Tool closures decrypt the live collections at call
// time, so registration happens once per workspace, not per data change.
export function useWebMcpActions() {
  const { getContext, journal, ready, userId } = useActionContext();
  useEffect(() => {
    if (!ready || !userId) return;
    const controller = new AbortController();
    registerWebMcpTools(buildWebMcpTools(getContext, { userId }), controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, userId]);
  return { webmcpJournal: journal };
}
