import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import type { openPatientWorkspace } from "@/src/lib/patient-workspace";
import type { openProjectWorkspace } from "@/src/lib/project-workspace";

type PatientWorkspace = Awaited<ReturnType<typeof openPatientWorkspace>>;
type ProjectWorkspace = Awaited<ReturnType<typeof openProjectWorkspace>>;
export type RetainedWorkspace =
  | { kind: "patients"; userId: string; workspace: PatientWorkspace }
  | { kind: "projects"; userId: string; workspace: ProjectWorkspace };

// External resource handles only: never a second copy of application records.
// Disabled Query observers give the root and pages a common lifetime. This query
// is never persisted; SSR can only see its empty initial value.
export const retainedWorkspaceOptions = queryOptions({
  queryKey: ["active-workspace-resources"],
  queryFn: async (): Promise<RetainedWorkspace[]> => [],
  initialData: [] as RetainedWorkspace[],
  enabled: false,
  gcTime: Infinity,
  structuralSharing: false,
});

export async function retainWorkspace(client: QueryClient, entry: RetainedWorkspace) {
  const current = client.getQueryData(retainedWorkspaceOptions.queryKey) ?? [];
  const replaced = current.filter(
    (item) => item.kind === entry.kind && item.workspace !== entry.workspace,
  );
  // close() wipes the key synchronously before its first await.
  await Promise.all(replaced.map((item) => item.workspace.close()));
  client.setQueryData(retainedWorkspaceOptions.queryKey, (rows = []) => [
    ...rows.filter((item) => item.kind !== entry.kind),
    entry,
  ]);
}
export async function releaseWorkspaces(
  client: QueryClient,
  predicate: (entry: RetainedWorkspace) => boolean = () => true,
) {
  const current = client.getQueryData(retainedWorkspaceOptions.queryKey) ?? [];
  const closing = current.filter(predicate);
  const closed = Promise.all(closing.map((item) => item.workspace.close()));
  client.setQueryData(
    retainedWorkspaceOptions.queryKey,
    current.filter((item) => !closing.includes(item)),
  );
  await closed;
}
