import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";

import type { TeamCommand } from "@/src/lib/team-model";
import { useProjectWorkspace } from "@/src/lib/use-project-workspace";

export function useTeamWorkspace() {
  const projectSpace = useProjectWorkspace();
  const { workspace, status } = projectSpace;
  const local = useLiveQuery(() => workspace?.team);
  const records =
    workspace && Date.now() < workspace.expiresAt
      ? (local.data
          ?.filter((row) => row.clientId !== workspace.teamSnapshotId)
          .map(workspace.readTeam) ?? [])
      : [];
  const failures = useQuery({
    queryKey: ["team-failures", workspace?.scope],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: () => workspace!.failedActions("team"),
  });
  const save = useMutation({
    mutationKey: ["team-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (command: TeamCommand) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveTeam(command);
    },
    onSuccess: () => {
      void status.refetch();
      void failures.refetch();
    },
  });
  return { ...projectSpace, records, local, failures, save };
}
