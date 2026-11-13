import { convexQuery } from "@convex-dev/react-query";
import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useMounted, useNetwork } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvex, useConvexAuth } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useRef } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/src/lib/auth-client";
import type { ClinicalLease } from "@/src/lib/clinical-identity";
import {
  clinicalHeaders,
  clinicalIdentity,
  lockClinicalAccess,
  persistClinicalHeader,
  prepareClinicalVault,
  rememberClinicalIdentity,
} from "@/src/lib/clinical-identity";
import { openProjectWorkspace } from "@/src/lib/project-workspace";
import { retainedWorkspaceOptions, retainWorkspace } from "@/src/lib/retained-workspaces";
import { openLocalData } from "@/src/observability/events";

export function useProjectWorkspace() {
  const { t } = useLingui();
  const mounted = useMounted();
  const { online } = useNetwork();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const retained = useQuery(retainedWorkspaceOptions);
  const identity = useMemo(
    () => (mounted ? openLocalData("storage.clinical", clinicalIdentity) : undefined),
    [mounted],
  );
  const remembered = useLiveQuery(() => identity);
  const previousUser = remembered.data?.find((row) => row.id === "current");
  const userId = session.data?.user.id ?? previousUser?.userId;
  const details = useQuery<FunctionReturnType<typeof api.profiles.mine>>({
    queryKey: convexQuery(api.profiles.mine, {}).queryKey,
    enabled: isAuthenticated,
  });
  const headers = useQuery({
    queryKey: ["clinical-headers", userId],
    enabled: mounted && Boolean(userId),
    networkMode: "always",
    queryFn: () => clinicalHeaders(userId!),
  });
  const memberships = details.data?.memberships.filter((m) => m.role !== "admin");
  const options =
    isAuthenticated && memberships
      ? memberships.map((m) => ({
          value: m.organizationId,
          label: m.organization?.name ?? m.organizationId,
        }))
      : (headers.data ?? [])
          .filter((h) => h.expiresAt > Date.now())
          .map((h) => ({ value: h.organizationId, label: h.organizationName }));
  const unlockForm = useForm({
    initialValues: { organizationId: "", passphrase: "", confirmation: "" },
    validate: {
      organizationId: (value) => (value ? null : t`Выберите организацию`),
      passphrase: (value) => (value.length >= 12 ? null : t`Не менее 12 символов`),
      confirmation: (value, values) =>
        headers.data?.some((h) => h.organizationId === values.organizationId) ||
        value === values.passphrase
          ? null
          : t`Парольные фразы должны совпадать`,
    },
  });
  type Workspace = Awaited<ReturnType<typeof openProjectWorkspace>>;
  const resource = useRef<
    { workspace: Workspace; userId: string; role: "doctor" | "researcher" } | undefined
  >(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [userId]);
  const unlock = useMutation({
    mutationKey: ["projects-open"],
    gcTime: 0,
    scope: { id: "clinical-unlock" },
    networkMode: "always",
    retry: false,
    mutationFn: async (input: Pick<typeof unlockForm.values, "organizationId">) => {
      const passphrase = unlockForm.getValues().passphrase;
      if (!userId) throw new Error("UNAUTHENTICATED");
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      let lease: ClinicalLease;
      let organizationName;
      if (isAuthenticated && online) {
        lease = await convex.query(api.profiles.offlineLease, {
          organizationId: input.organizationId as Id<"organizations">,
          nonce: crypto.randomUUID(),
        });
        if (lease.userId !== userId) throw new Error("ACCOUNT_CHANGED");
        organizationName =
          memberships?.find((m) => m.organizationId === lease.organizationId)?.organization?.name ??
          lease.organizationId;
      } else {
        const existing = clinicalHeaders(userId).find(
          (h) => h.organizationId === input.organizationId && h.expiresAt > Date.now(),
        );
        if (!existing) throw new Error("OFFLINE_NOT_PREPARED");
        lease = {
          userId,
          organizationId: existing.organizationId as Id<"organizations">,
          role: existing.role,
          expiresAt: existing.expiresAt,
        };
        organizationName = existing.organizationName;
      }
      const { vault, header } = await prepareClinicalVault({
        lease,
        organizationName,
        passphrase,
        onlineVerified: isAuthenticated && online,
      });
      if (abort.signal.aborted) {
        vault.lock();
        throw new Error("CANCELLED");
      }
      try {
        persistClinicalHeader(header);
        await rememberClinicalIdentity(
          userId,
          session.data?.user.name ?? previousUser?.label ?? userId,
        );
      } catch (error) {
        vault.lock();
        throw error;
      }
      const workspace = await openProjectWorkspace({
        client: convex,
        ...lease,
        vault,
        signal: abort.signal,
        onAuthRequired: () => {
          void session.refetch();
        },
      }).catch((error) => {
        vault.lock();
        throw error;
      });
      try {
        if (abort.signal.aborted) throw new Error("CANCELLED");
        await retainWorkspace(queryClient, { kind: "projects", userId, workspace });
        resource.current = { workspace, userId, role: lease.role };
        workspace.setAuthenticated(isAuthenticated && online);
        return resource.current;
      } catch (error) {
        await workspace.close();
        throw error;
      }
    },
    onSuccess: () => {
      unlockForm.setFieldValue("passphrase", "");
      unlockForm.setFieldValue("confirmation", "");
      void queryClient.invalidateQueries({ queryKey: ["clinical-headers"] });
    },
  });
  const active = retained.data.find(
    (entry) =>
      entry.kind === "projects" && entry.userId === userId && entry.userId === previousUser?.userId,
  );
  const opened =
    active?.kind === "projects" ? { ...active, role: active.workspace.role } : undefined;
  const workspace = opened?.workspace;
  const downloaded = useLiveQuery(() => workspace?.collection);
  const status = useQuery({
    queryKey: ["project-status", workspace?.scope],
    gcTime: 0,
    enabled: Boolean(workspace),
    networkMode: "always",
    refetchInterval: 2000,
    queryFn: async () => ({
      pending: workspace!.executor.getPendingCount() + workspace!.executor.getRunningCount(),
      leader: workspace!.canWrite(),
      online: workspace!.executor.isOnline() && convex.connectionState().isWebSocketConnected,
      failures: await workspace!.failedActions(),
    }),
  });
  const rows =
    workspace && Date.now() < workspace.expiresAt
      ? (downloaded.data
          ?.filter((row) => row.clientId !== workspace.projectSnapshotId)
          .flatMap((row) => {
            try {
              return [workspace.read(row)];
            } catch (error) {
              if (error instanceof Error && error.message === "ACCESS_DENIED") return [];
              throw error;
            }
          }) ?? [])
      : [];
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const resume = useMutation({
    mutationKey: ["projects-resume"],
    retry: false,
    mutationFn: async () => {
      if (!workspace || !opened) throw new Error("WORKSPACE_LOCKED");
      const lease = await convex.query(api.profiles.offlineLease, {
        organizationId: workspace.organizationId,
        nonce: crypto.randomUUID(),
      });
      if (lease.userId !== opened.userId || lease.role !== opened.role)
        throw new Error("ACCOUNT_CHANGED");
      if (Date.now() >= workspace.expiresAt) throw new Error("OFFLINE_ACCESS_EXPIRED");
      workspace.confirmAuthentication();
    },
  });
  const lock = useMutation({
    mutationKey: ["projects-lock"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      try {
        await lockClinicalAccess(queryClient);
      } finally {
        await workspace?.close();
        resource.current = undefined;
        unlock.reset();
        queryClient.removeQueries({ queryKey: ["project-status"] });
      }
    },
  });
  return {
    userId,
    online,
    isAuthenticated,
    workspace,
    rows,
    status,
    headers,
    options,
    unlockForm,
    unlock,
    lock,
    resume,
    downloaded,
  };
}
