import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useMounted, useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvex, useConvexAuth } from "convex/react";
import { useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";
import { authClient } from "@/src/lib/auth-client";
import { clinicalIdentity, rememberClinicalIdentity } from "@/src/lib/clinical-identity";
import {
  libraryHeader,
  prepareLibraryVault,
  persistLibraryHeader,
} from "@/src/lib/library-identity";
import type { LibraryLease } from "@/src/lib/library-identity";
import { openLibraryWorkspace } from "@/src/lib/library-workspace";
import {
  retainedWorkspaceOptions,
  retainWorkspace,
  releaseWorkspaces,
} from "@/src/lib/retained-workspaces";
import { openLocalData } from "@/src/observability/events";

export function useLibraryWorkspace() {
  const { t } = useLingui();
  const mounted = useMounted();
  const { online } = useNetwork();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const session = authClient.useSession();
  const client = useQueryClient();
  const identity = useMemo(
    () => (mounted ? openLocalData("storage.clinical", clinicalIdentity) : undefined),
    [mounted],
  );
  const remembered = useLiveQuery(() => identity);
  const previousUser = remembered.data?.find((row) => row.id === "current");
  const userId = session.data?.user.id ?? previousUser?.userId;
  const retained = useQuery(retainedWorkspaceOptions);
  const active = retained.data.find(
    (row) => row.kind === "library" && row.userId === userId && row.userId === previousUser?.userId,
  );
  const workspace = active?.kind === "library" ? active.workspace : undefined;
  const header = useQuery({
    queryKey: ["library-vault", userId],
    enabled: mounted && Boolean(userId),
    gcTime: 0,
    networkMode: "always",
    queryFn: () => libraryHeader(userId!) ?? null,
  });
  const unlockForm = useForm({
    initialValues: { passphrase: "", confirmation: "" },
    validate: {
      passphrase: (value) => (value.length >= 12 ? null : t`Не менее 12 символов`),
      confirmation: (value, values) =>
        header.data || value === values.passphrase ? null : t`Парольные фразы должны совпадать`,
    },
  });
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [userId]);
  const unlock = useMutation({
    mutationKey: ["library-open"],
    scope: { id: "clinical-unlock" },
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async () => {
      if (!userId) throw new Error("UNAUTHENTICATED");
      const passphrase = unlockForm.getValues().passphrase;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      let lease: LibraryLease;
      if (isAuthenticated && online) {
        lease = await convex.query(api.library.offlineLease, {
          actorId: userId,
          nonce: crypto.randomUUID(),
        });
        if (lease.userId !== userId) throw new Error("ACCOUNT_CHANGED");
      } else {
        const existing = libraryHeader(userId);
        if (!existing) throw new Error("OFFLINE_NOT_PREPARED");
        lease = { userId, purpose: "library", expiresAt: existing.expiresAt };
      }
      const { vault, header: prepared } = await prepareLibraryVault({
        lease,
        passphrase,
        onlineVerified: isAuthenticated && online,
      });
      try {
        if (abort.signal.aborted) throw new Error("CANCELLED");
        persistLibraryHeader(prepared);
        await rememberClinicalIdentity(
          userId,
          session.data?.user.name ?? previousUser?.label ?? userId,
        );
        const opened = await openLibraryWorkspace({
          client: convex,
          userId,
          expiresAt: lease.expiresAt,
          vault,
          signal: abort.signal,
          onAuthRequired: () => void client.invalidateQueries({ queryKey: ["library-status"] }),
        });
        if (abort.signal.aborted) {
          await opened.close();
          throw new Error("CANCELLED");
        }
        await retainWorkspace(client, { kind: "library", userId, workspace: opened });
        opened.setAuthenticated(isAuthenticated && online);
      } catch (error) {
        vault.lock();
        throw error;
      }
    },
    onSuccess: () => {
      unlockForm.reset();
      void header.refetch();
    },
  });
  const lock = useMutation({
    mutationKey: ["library-lock"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: () => releaseWorkspaces(client, (row) => row.kind === "library"),
  });
  const resume = useMutation({
    mutationKey: ["library-resume"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async () => {
      if (!workspace || !userId) throw new Error("WORKSPACE_LOCKED");
      const lease = await convex.query(api.library.offlineLease, {
        actorId: userId,
        nonce: crypto.randomUUID(),
      });
      if (lease.userId !== userId) throw new Error("ACCOUNT_CHANGED");
      if (Date.now() >= workspace.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
      workspace.confirmAuthentication();
    },
    onSuccess: () => void status.refetch(),
  });
  const source = useLiveQuery(() => workspace?.collection);
  const history = useLiveQuery(() => workspace?.versions);
  const rows =
    workspace && Date.now() < workspace.expiresAt
      ? (source.data ?? [])
          .filter((row) => row.clientId !== workspace.snapshotId && !row.deleted)
          .map(workspace.read)
      : [];
  const versions =
    workspace && Date.now() < workspace.expiresAt
      ? (history.data ?? [])
          .filter((row) => row.clientId !== workspace.versionSnapshotId)
          .flatMap((envelope) => {
            try {
              return [workspace.readVersion(envelope)];
            } catch (error) {
              if (error instanceof Error && error.message === "LIBRARY_ITEM_DELETED") return [];
              throw error;
            }
          })
      : [];
  const status = useQuery({
    queryKey: ["library-status", workspace?.scope],
    enabled: Boolean(workspace),
    gcTime: 0,
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () => ({
      pending: workspace!.executor.getPendingCount() + workspace!.executor.getRunningCount(),
      online: workspace!.executor.isOnline() && convex.connectionState().isWebSocketConnected,
      failures: await workspace!.failedActions(),
    }),
  });
  return {
    userId,
    online,
    isAuthenticated,
    workspace,
    header,
    unlockForm,
    unlock,
    lock,
    resume,
    source,
    history,
    rows,
    versions,
    status,
  };
}
