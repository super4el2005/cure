import { convexQuery } from "@convex-dev/react-query";
import { useInterval, useForceUpdate, useMounted, useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvexAuth } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";
import { authClient } from "@/src/lib/auth-client";
import { clinicalIdentity } from "@/src/lib/clinical-identity";
import { retainedWorkspaceOptions, releaseWorkspaces } from "@/src/lib/retained-workspaces";
import type { RetainedWorkspace } from "@/src/lib/retained-workspaces";
import { workspaceAdmission } from "@/src/lib/workspace-admission";
import { openLocalData, reportFailure } from "@/src/observability/events";

export function useRetainedWorkspaces() {
  const client = useQueryClient();
  const retained = useQuery(retainedWorkspaceOptions);
  const mounted = useMounted();
  const { online } = useNetwork();
  const { isAuthenticated } = useConvexAuth();
  const session = authClient.useSession();
  const identity = useMemo(
    () => (mounted ? openLocalData("storage.clinical", clinicalIdentity) : undefined),
    [mounted],
  );
  const remembered = useLiveQuery(() => identity);
  const localUserId = remembered.data?.find((row) => row.id === "current")?.userId;
  const profile = useQuery<FunctionReturnType<typeof api.profiles.mine>>({
    queryKey: convexQuery(api.profiles.mine, {}).queryKey,
    enabled: isAuthenticated,
  });
  const previous = useRef<RetainedWorkspace[]>([]);
  useInterval(useForceUpdate(), 1000, { autoInvoke: true });
  const now = Date.now();
  useEffect(() => {
    // Also dispose removed Query entries (for example QueryClient.clear).
    for (const entry of previous.current)
      if (!retained.data.includes(entry))
        void entry.workspace.close().catch((error) => reportFailure(error, "workspace.close"));
    previous.current = retained.data;
    for (const entry of retained.data) {
      const admission = workspaceAdmission(
        { userId: entry.userId, ...entry.workspace },
        {
          now,
          localReady: remembered.isReady,
          localUserId,
          sessionUserId: session.data?.user.id,
          isAuthenticated,
          online,
          profile: profile.data,
        },
      );
      if (admission === "close") {
        void releaseWorkspaces(client, (item) => item === entry).catch((error) =>
          reportFailure(error, "workspace.close"),
        );
      } else entry.workspace.setAuthenticated(admission === "sync");
    }
  }, [
    client,
    retained.data,
    remembered.isReady,
    localUserId,
    session.data?.user.id,
    now,
    isAuthenticated,
    online,
    profile.data,
  ]);
  useEffect(
    () => () => {
      void releaseWorkspaces(client).catch((error) => reportFailure(error, "workspace.close"));
    },
    [client],
  );
}
