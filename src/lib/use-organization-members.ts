import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useNetwork, useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConvex, useConvexAuth } from "convex/react";
import type { ZodSafeParseResult } from "zod";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { authClient } from "@/src/lib/auth-client";
import {
  membershipChangeSchema,
  membershipRequestValuesSchema,
  membershipReviewSchema,
} from "@/src/lib/organization-membership-model";

const nextPage = (page: { isDone: boolean; continueCursor: string }) =>
  page.isDone ? undefined : page.continueCursor;
export function useOrganizationMembers() {
  const { t } = useLingui();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { online } = useNetwork();
  const convex = useConvex();
  const cache = useQueryClient();
  const ready = Boolean(userId && isAuthenticated && online);
  const profile = useQuery({
    queryKey: ["organization-access", "profile", userId],
    enabled: ready,
    gcTime: 0,
    refetchInterval: 30000,
    queryFn: () => convex.query(api.profiles.mine, {}),
  });
  const current =
    ready && !profile.isError && profile.data?.userId === userId ? profile.data : undefined;
  const selection = useForm({ initialValues: { organizationId: "", organizationSearch: "" } });
  const [search] = useDebouncedValue(selection.values.organizationSearch, 300);
  const organizations = useInfiniteQuery({
    queryKey: ["organization-access", "directory", userId, search],
    enabled: ready,
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      convex.query(api.organizationMembers.joinable, {
        actorId: userId!,
        search,
        paginationOpts: { cursor: pageParam, numItems: 25 },
      }),
    getNextPageParam: nextPage,
  });
  const organizationRows =
    ready && !organizations.isError
      ? (organizations.data?.pages
          .filter((page) => page.actorId === userId)
          .flatMap((page) => page.page) ?? [])
      : [];
  const administrative = current?.memberships.filter((row) => row.role === "admin") ?? [];
  const organizationId = administrative.find(
    (row) => row.organizationId === selection.values.organizationId,
  )?.organizationId;
  const owned = useInfiniteQuery({
    queryKey: ["organization-access", "mine", userId],
    enabled: Boolean(current),
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      convex.query(api.organizationMembers.mine, {
        actorId: userId!,
        paginationOpts: { cursor: pageParam, numItems: 25 },
      }),
    getNextPageParam: nextPage,
    refetchInterval: 30000,
  });
  const members = useInfiniteQuery({
    queryKey: ["organization-access", "members", userId, organizationId],
    enabled: Boolean(current && organizationId),
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      convex.query(api.organizationMembers.members, {
        actorId: userId!,
        organizationId: organizationId!,
        paginationOpts: { cursor: pageParam, numItems: 25 },
      }),
    getNextPageParam: nextPage,
    refetchInterval: 30000,
  });
  const pending = useInfiniteQuery({
    queryKey: ["organization-access", "pending", userId, organizationId],
    enabled: Boolean(current && organizationId),
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      convex.query(api.organizationMembers.pending, {
        actorId: userId!,
        organizationId: organizationId!,
        paginationOpts: { cursor: pageParam, numItems: 25 },
      }),
    getNextPageParam: nextPage,
    refetchInterval: 30000,
  });
  const audit = useInfiniteQuery({
    queryKey: ["organization-access", "audit", userId, organizationId],
    enabled: Boolean(current && organizationId),
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      convex.query(api.organizationMembers.audit, {
        actorId: userId!,
        organizationId: organizationId!,
        paginationOpts: { cursor: pageParam, numItems: 25 },
      }),
    getNextPageParam: nextPage,
    refetchInterval: 30000,
  });
  const errorFields = (result: ZodSafeParseResult<unknown>) =>
    result.success
      ? {}
      : Object.fromEntries(
          result.error.issues.map((issue) => [issue.path.join("."), t`Проверьте значение поля`]),
        );
  const requestForm = useForm({
    initialValues: {
      actorId: "",
      organizationId: "",
      organizationName: "",
      expectedRevision: 0,
      role: "researcher" as "doctor" | "researcher",
      message: "",
      idempotencyKey: "",
    },
    validate: (values) => {
      const result = membershipRequestValuesSchema.safeParse(values);
      return {
        ...errorFields(result),
        ...(!values.organizationId ? { organizationId: t`Выберите организацию` } : {}),
      };
    },
  });
  const reviewForm = useForm({
    initialValues: {
      actorId: "",
      organizationId: "",
      requestId: "",
      targetName: "",
      requestedRole: "researcher" as "doctor" | "researcher",
      expectedRevision: 0,
      approved: true,
      reason: "",
      idempotencyKey: "",
    },
    validate: (values) => errorFields(membershipReviewSchema.safeParse(values)),
  });
  const changeForm = useForm({
    initialValues: {
      actorId: "",
      organizationId: "",
      membershipId: "",
      targetName: "",
      expectedRevision: 0,
      role: "researcher" as "doctor" | "researcher" | "admin",
      active: true,
      reason: "",
      idempotencyKey: "",
    },
    validate: (values) => errorFields(membershipChangeSchema.safeParse(values)),
  });
  const requireOnline = (expectedActor: string, adminOrganization?: string) => {
    if (!online || !convex.connectionState().isWebSocketConnected) throw new Error("NETWORK_ERROR");
    if (!current || expectedActor !== userId) throw new Error("ACCOUNT_CHANGED");
    if (adminOrganization && adminOrganization !== organizationId) throw new Error("ACCESS_DENIED");
  };
  const refresh = () => cache.invalidateQueries({ queryKey: ["organization-access"] });
  const request = useMutation({
    mutationKey: ["organization-membership-request"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof requestForm.values) => {
      requireOnline(input.actorId);
      const { organizationName: _organizationName, ...values } = input;
      return convex.mutation(api.organizationMembers.request, {
        ...values,
        organizationId: input.organizationId as Id<"organizations">,
      });
    },
    onSuccess: (_result, input) => {
      if (JSON.stringify(requestForm.getValues()) === JSON.stringify(input)) requestForm.reset();
      void refresh();
    },
  });
  const withdraw = useMutation({
    mutationKey: ["organization-membership-withdraw"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: {
      actorId: string;
      requestId: Id<"membershipRequests">;
      expectedRevision: number;
      idempotencyKey: string;
    }) => {
      requireOnline(input.actorId);
      return convex.mutation(api.organizationMembers.withdraw, input);
    },
    onSuccess: () => {
      void refresh();
    },
  });
  const review = useMutation({
    mutationKey: ["organization-membership-review"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof reviewForm.values) => {
      requireOnline(input.actorId, input.organizationId);
      const {
        organizationId: _organizationId,
        targetName: _targetName,
        requestedRole: _requestedRole,
        ...values
      } = input;
      return convex.mutation(api.organizationMembers.review, {
        ...values,
        requestId: values.requestId as Id<"membershipRequests">,
      });
    },
    onSuccess: (_result, input) => {
      if (JSON.stringify(reviewForm.getValues()) === JSON.stringify(input)) reviewForm.reset();
      void refresh();
    },
  });
  const change = useMutation({
    mutationKey: ["organization-membership-change"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof changeForm.values) => {
      requireOnline(input.actorId, input.organizationId);
      const { organizationId: _organizationId, targetName: _targetName, ...values } = input;
      return convex.mutation(api.organizationMembers.change, {
        ...values,
        membershipId: values.membershipId as Id<"memberships">,
      });
    },
    onSuccess: (_result, input) => {
      if (JSON.stringify(changeForm.getValues()) === JSON.stringify(input)) changeForm.reset();
      void refresh();
    },
  });
  const ownRows =
    current && !owned.isError
      ? (owned.data?.pages.filter((page) => page.actorId === userId).flatMap((page) => page.page) ??
        [])
      : [];
  const memberRows =
    current && organizationId && !members.isError
      ? (members.data?.pages
          .filter((page) => page.actorId === userId)
          .flatMap((page) => page.page) ?? [])
      : [];
  const pendingRows =
    current && organizationId && !pending.isError
      ? (pending.data?.pages
          .filter((page) => page.actorId === userId)
          .flatMap((page) => page.page) ?? [])
      : [];
  const auditRows =
    current && organizationId && !audit.isError
      ? (audit.data?.pages.filter((page) => page.actorId === userId).flatMap((page) => page.page) ??
        [])
      : [];
  return {
    userId,
    isAuthenticated,
    isLoading,
    online,
    current,
    profile,
    organizations,
    organizationRows,
    selection,
    administrative,
    organizationId,
    owned,
    members,
    pending,
    audit,
    ownRows,
    memberRows,
    pendingRows,
    auditRows,
    requestForm,
    reviewForm,
    changeForm,
    request,
    withdraw,
    review,
    change,
    refresh,
    startRequest: (selectedOrganizationId: string, expectedRevision = 0, organizationName = "") => {
      requestForm.setValues({
        ...requestForm.getInitialValues(),
        actorId: userId ?? "",
        organizationId: selectedOrganizationId,
        organizationName,
        expectedRevision,
        role: current?.profile?.profession ?? "researcher",
        idempotencyKey: crypto.randomUUID(),
      });
      requestForm.clearErrors();
    },
    startReview: (row: (typeof pendingRows)[number], approved: boolean) => {
      reviewForm.setValues({
        ...reviewForm.getInitialValues(),
        actorId: userId ?? "",
        organizationId: organizationId ?? "",
        requestId: row._id,
        targetName: row.displayName,
        requestedRole: row.role,
        expectedRevision: row.revision,
        approved,
        idempotencyKey: crypto.randomUUID(),
      });
      reviewForm.clearErrors();
    },
    startChange: (row: (typeof memberRows)[number]) => {
      changeForm.setValues({
        ...changeForm.getInitialValues(),
        actorId: userId ?? "",
        organizationId: organizationId ?? "",
        membershipId: row.id,
        targetName: row.displayName,
        expectedRevision: row.revision,
        role: row.role,
        active: row.active,
        idempotencyKey: crypto.randomUUID(),
      });
      changeForm.clearErrors();
    },
  };
}
