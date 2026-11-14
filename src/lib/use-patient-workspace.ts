import { convexQuery } from "@convex-dev/react-query";
import { useLingui } from "@lingui/react/macro";
import { schemaResolver, useForm } from "@mantine/form";
import { useDisclosure, useMounted, useNetwork, useForceUpdate, useInterval } from "@mantine/hooks";
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
import type { ConsentEvent } from "@/src/lib/consent-model";
import { patientFormSchema, patientValueSchema } from "@/src/lib/patient-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { openPatientWorkspace } from "@/src/lib/patient-workspace";
import { retainedWorkspaceOptions, retainWorkspace } from "@/src/lib/retained-workspaces";
import { openLocalData } from "@/src/observability/events";

export function usePatientWorkspace() {
  useInterval(useForceUpdate(), 1000, { autoInvoke: true });
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
  const [editing, editor] = useDisclosure(false);
  const [sharing, sharingDialog] = useDisclosure(false);
  const [consenting, consentDialog] = useDisclosure(false);
  const consentForm = useForm({
    enhanceGetInputProps: ({ form }) => (form.submitting ? { disabled: true } : {}),
    initialValues: {
      clientId: "",
      expectedRevision: 0,
      expectedHistoryId: null as string | null,
      workspaceScope: "",
      kind: "granted" as "granted" | "withdrawn",
      purpose: "",
      recipients: [] as string[],
      scope: ["sex", "diagnoses"] as ("sex" | "diagnoses")[],
      documentReference: "",
      days: 30 as number | string,
      attested: false,
      failureId: "",
      archivedExpiresAt: 0,
    },
    validate: {
      purpose: (value) => (value.trim() ? null : t`Укажите цель использования данных`),
      documentReference: (value) => (value.trim() ? null : t`Укажите источник подтверждения`),
      recipients: (value) => (value.length ? null : t`Выберите получателей`),
      scope: (value) => (value.length ? null : t`Выберите состав данных`),
      days: (value, values) =>
        values.kind === "withdrawn" ||
        values.archivedExpiresAt ||
        (typeof value === "number" && value >= 1 && value <= 365)
          ? null
          : t`От 1 до 365 дней`,
      attested: (value) =>
        value ? null : t`Подтвердите наличие документированного согласия или отзыва`,
    },
  });
  const shareForm = useForm({
    enhanceGetInputProps: ({ form }) => (form.submitting ? { disabled: true } : {}),
    initialValues: {
      workspaceScope: "",
      clientId: "",
      researcherId: "",
      days: 30 as number | string,
      active: true,
    },
    validate: {
      researcherId: (value) => (value ? null : t`Выберите исследователя`),
      days: (value) =>
        typeof value === "number" && value >= 1 && value <= 365 ? null : t`От 1 до 365 дней`,
    },
  });
  const patientForm = useForm({
    enhanceGetInputProps: ({ form }) => (form.submitting ? { disabled: true } : {}),
    initialValues: {
      clientId: "",
      expectedRevision: 0,
      expectedHistoryId: null as string | null,
      workspaceScope: "",
      fullName: "",
      birthDate: "",
      sex: "unknown" as "female" | "male" | "unknown",
      diagnosisCodes: "",
      notes: "",
      failureId: "",
    },
    validate: (values) => {
      const errors = schemaResolver(patientFormSchema)(values);
      return Object.fromEntries(
        Object.keys(errors).map((field) => [field, t`Проверьте значение поля`]),
      );
    },
  });
  type Workspace = Awaited<ReturnType<typeof openPatientWorkspace>>;
  const resource = useRef<
    { workspace: Workspace; userId: string; role: "doctor" | "researcher" } | undefined
  >(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [userId]);
  const unlock = useMutation({
    mutationKey: ["patients-open"],
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
      const workspace = await openPatientWorkspace({
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
        await retainWorkspace(queryClient, { kind: "patients", userId, workspace });
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
      entry.kind === "patients" && entry.userId === userId && entry.userId === previousUser?.userId,
  );
  const opened =
    active?.kind === "patients" ? { ...active, role: active.workspace.role } : undefined;
  const workspace = opened?.workspace;
  const downloaded = useLiveQuery(() => workspace?.collection);
  const status = useQuery({
    queryKey: ["patient-status", workspace?.scope],
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
          ?.filter((row) => !row.deleted && row.clientId !== workspace.patientSnapshotId)
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
  const restore = useMutation({
    mutationKey: ["patients-restore"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      if (failure.action === "delete") throw new Error("INVALID_PATIENT");
      const row = workspace.read(failure.envelope);
      const currentEnvelope = workspace.collection.get(row.clientId);
      const current =
        currentEnvelope && !currentEnvelope.deleted ? workspace.read(currentEnvelope) : undefined;
      if (failure.consentId) {
        if (!current) throw new Error("PATIENT_NOT_FOUND");
        const event = row.consentHistory.find((item) => item.id === failure.consentId);
        if (!event) throw new Error("INVALID_VAULT_DATA");
        consentForm.setValues({
          clientId: row.clientId,
          expectedRevision: current?.revision ?? 0,
          expectedHistoryId: current?.historyId ?? null,
          workspaceScope: workspace.scope,
          kind: event.kind,
          purpose: event.purpose,
          recipients: event.recipients,
          scope: event.scope,
          documentReference: event.documentReference,
          days: 30,
          archivedExpiresAt: event.expiresAt,
          failureId: failure.id,
          attested: false,
        });
        consentDialog.open();
        return;
      }
      patientForm.setValues({
        ...row,
        clientId: current ? row.clientId : "",
        consentHistory: current ? row.consentHistory : [],
        expectedRevision: current?.revision ?? 0,
        expectedHistoryId: current?.historyId ?? null,
        workspaceScope: workspace.scope,
        diagnosisCodes: row.diagnosisCodes.join(", "),
        failureId: failure.id,
      });
      editor.open();
    },
  });
  const save = useMutation({
    mutationKey: ["patients-save"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (input: typeof patientForm.values) => {
      if (!workspace || input.workspaceScope !== workspace.scope)
        throw new Error("WORKSPACE_LOCKED");
      const values = patientFormSchema.parse(input);
      const clientId = input.clientId || crypto.randomUUID();
      const result = await workspace.save({
        clientId,
        expectedRevision: input.expectedRevision,
        expectedHistoryId: input.expectedHistoryId,
        action: workspace.collection.has(clientId) ? "update" : "create",
        values: patientValueSchema.parse(values),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (
        JSON.stringify(patientForm.getValues()) === JSON.stringify(input) &&
        patientForm.getValues().workspaceScope === input.workspaceScope &&
        patientForm.getValues().clientId === input.clientId &&
        patientForm.getValues().expectedHistoryId === input.expectedHistoryId
      ) {
        patientForm.reset();
        editor.close();
      }
      void status.refetch();
    },
  });
  const remove = useMutation({
    mutationKey: ["patients-delete"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (input: {
      clientId: string;
      expectedRevision: number;
      expectedHistoryId: string | null;
      workspaceScope: string;
    }) => {
      if (!workspace || input.workspaceScope !== workspace.scope)
        throw new Error("WORKSPACE_LOCKED");
      return workspace.save({ action: "delete", ...input });
    },
    onSuccess: () => {
      void status.refetch();
    },
  });
  const researchers = useQuery({
    queryKey: ["patient-researchers", workspace?.scope, online, isAuthenticated],
    enabled: opened?.role === "doctor",
    networkMode: "always",
    queryFn: async () => {
      if (online && isAuthenticated) {
        const people = await convex.query(api.patients.researchers, {
          actorId: opened!.userId,
          organizationId: workspace!.organizationId,
        });
        await workspace!.cacheResearchers(people);
        return people;
      }
      return workspace!.cachedResearchers();
    },
  });
  const consent = useMutation({
    mutationKey: ["patients-consent"],
    gcTime: 0,
    networkMode: "always",
    retry: false,
    mutationFn: async (input: typeof consentForm.values) => {
      if (!workspace || !opened || input.workspaceScope !== workspace.scope)
        throw new Error("WORKSPACE_LOCKED");
      const envelope = workspace.collection.get(input.clientId);
      if (!envelope) throw new Error("PATIENT_NOT_FOUND");
      const row = workspace.read(envelope);
      const event: ConsentEvent = {
        id: crypto.randomUUID(),
        version: row.consentHistory.length + 1,
        kind: input.kind,
        purpose: input.purpose.trim(),
        recipients: input.recipients,
        scope: input.scope,
        documentReference: input.documentReference.trim(),
        expiresAt:
          input.archivedExpiresAt ||
          (input.kind === "withdrawn"
            ? (row.consentHistory.at(-1)?.expiresAt ?? Date.now())
            : Date.now() + Number(input.days) * 86400000),
        recordedAt: Date.now(),
        recordedBy: opened.userId,
      };
      const result = await workspace.save({
        action: "consent",
        expectedHistoryId: input.expectedHistoryId,
        expectedRevision: input.expectedRevision,
        clientId: input.clientId,
        consent: event,
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (
        JSON.stringify(consentForm.getValues()) === JSON.stringify(input) &&
        consentForm.getValues().workspaceScope === input.workspaceScope &&
        consentForm.getValues().clientId === input.clientId &&
        consentForm.getValues().expectedHistoryId === input.expectedHistoryId
      ) {
        consentDialog.close();
        consentForm.reset();
      }
      void status.refetch();
    },
  });
  const share = useMutation({
    mutationKey: ["patients-share"],
    retry: false,
    mutationFn: async (values: typeof shareForm.values) => {
      if (
        !workspace ||
        !opened ||
        values.workspaceScope !== workspace.scope ||
        !online ||
        !isAuthenticated
      )
        throw new Error("UNAUTHENTICATED");
      return convex.mutation(api.patients.share, {
        actorId: opened.userId,
        organizationId: workspace.organizationId,
        clientId: values.clientId,
        researcherId: values.researcherId,
        expiresAt: Date.now() + Number(values.days) * 24 * 60 * 60 * 1000,
        active: values.active,
      });
    },
    onSuccess: (_result, input) => {
      if (JSON.stringify(shareForm.getValues()) === JSON.stringify(input)) {
        sharingDialog.close();
        shareForm.reset();
      }
    },
  });
  const resume = useMutation({
    mutationKey: ["patients-resume"],
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
    mutationKey: ["patients-lock"],
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      try {
        await lockClinicalAccess(queryClient);
      } finally {
        await workspace?.close();
        resource.current = undefined;
        unlock.reset();
        save.reset();
        remove.reset();
        queryClient.removeQueries({ queryKey: ["patient-status"] });
        patientForm.reset();
        editor.close();
        consentDialog.close();
        consentForm.reset();
        consent.reset();
        restore.reset();
      }
    },
  });
  return {
    userId,
    online,
    isAuthenticated,
    workspace,
    opened,
    rows,
    options,
    headers,
    unlockForm,
    unlock,
    editing:
      editing && Boolean(workspace) && patientForm.values.workspaceScope === workspace?.scope,
    editor,
    sharing: sharing && Boolean(workspace) && shareForm.values.workspaceScope === workspace?.scope,
    sharingDialog,
    consenting:
      consenting && Boolean(workspace) && consentForm.values.workspaceScope === workspace?.scope,
    consentDialog,
    patientForm,
    consentForm,
    shareForm,
    save,
    remove,
    share,
    consent,
    restore,
    lock,
    resume,
    researchers,
    downloaded,
    status,
  };
}
