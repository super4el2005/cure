import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";

import { useTeamWorkspace } from "@/src/lib/use-team-workspace";

export function useProjectWork() {
  const projectSpace = useTeamWorkspace();
  const { workspace } = projectSpace;
  const localWork = useLiveQuery(() => workspace?.work);
  const workRecords =
    workspace && Date.now() < workspace.expiresAt
      ? (localWork.data
          ?.filter((row) => row.clientId !== workspace.workSnapshotId)
          .map(workspace.readWork) ?? [])
      : [];
  const workFailures = useQuery({
    queryKey: ["project-work-failures", workspace?.scope],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () => [
      ...(await workspace!.failedActions("task")),
      ...(await workspace!.failedActions("message")),
    ],
  });
  return { ...projectSpace, localWork, workRecords, workFailures };
}
