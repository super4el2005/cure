import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure, useMounted, usePagination } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useMemo } from "react";

import { medicalResultSchema, medicalSearchSchema } from "@/src/lib/contracts";
import { useSearchMedical } from "@/src/lib/generated/cure";
import { libraryEntrySchema } from "@/src/lib/library-model";
import type { LibraryEntry, LibraryRow } from "@/src/lib/library-model";
import {
  emptyLibraryEntry,
  filterLibrary,
  matchingPublication,
  publicationEntry,
} from "@/src/lib/library-selection";
import type { FailedLibraryAction } from "@/src/lib/library-workspace";
import { createMedicalCache, saveMedicalRecords } from "@/src/lib/medical-cache";
import { filterMedicalRecords } from "@/src/lib/medical-catalog";
import type { MedicalRecord, MedicalResult } from "@/src/lib/medical-catalog";
import { useLibraryWorkspace } from "@/src/lib/use-library-workspace";
import { openLocalData } from "@/src/observability/events";

const initial = {
  ...emptyLibraryEntry,
  year: "" as number | string,
  scope: "",
  clientId: "",
  expectedRevision: 0,
  failureId: "",
};
function values(input: typeof initial) {
  return libraryEntrySchema.parse({ ...input, year: input.year === "" ? null : input.year });
}
export function useLibrary() {
  const space = useLibraryWorkspace();
  const { workspace, rows, status } = space;
  const { t } = useLingui();
  const mounted = useMounted();
  const catalog = useMemo(
    () =>
      mounted
        ? openLocalData("storage.catalog", () => createMedicalCache(window.localStorage))
        : undefined,
    [mounted],
  );
  const cache = useLiveQuery(() => catalog);
  const searchForm = useForm({
    initialValues: { query: "", offset: 0 },
    validate: {
      query: (value) =>
        medicalSearchSchema.safeParse({ source: "pubmed", query: value }).success
          ? null
          : t`Введите от 2 до 100 символов`,
    },
  });
  const cacheResult = useMutation({
    mutationKey: ["library-cache-publications"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (result: MedicalResult) => {
      if (!catalog) return false;
      try {
        await saveMedicalRecords(catalog, result.records);
        return true;
      } catch {
        return false;
      }
    },
  });
  const search = useSearchMedical({
    mutation: {
      networkMode: "always",
      retry: false,
      gcTime: 0,
      onMutate: () => cacheResult.reset(),
      onSuccess: async (result) => {
        await cacheResult.mutateAsync(medicalResultSchema.parse(result));
      },
    },
  });
  const matches =
    search.variables?.data.query === searchForm.values.query.trim() &&
    (search.variables?.data.source !== "pubmed" ||
      (search.variables.data.offset ?? 0) === searchForm.values.offset);
  const publications =
    matches && search.data
      ? medicalResultSchema.parse(search.data).records
      : filterMedicalRecords(cache.data ?? [], "pubmed", searchForm.values.query).slice(0, 100);
  const filters = useForm({
    initialValues: {
      query: "",
      status: "all",
      collection: null as string | null,
      tags: [] as string[],
    },
  });
  const selected = filterLibrary(rows, filters.values);
  const pageCount = Math.max(1, Math.ceil(selected.length / 20));
  const pagination = usePagination({ total: pageCount });
  const page = Math.min(pagination.active, pageCount);
  const [editing, editor] = useDisclosure(false);
  const form = useForm({
    initialValues: initial,
    validate: (input) => {
      const result = libraryEntrySchema.safeParse({
        ...input,
        year: input.year === "" ? null : input.year,
      });
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => [
              String(issue.path[0] ?? "_form"),
              t`Проверьте значение поля`,
            ]),
          );
    },
  });
  const assign = (entry: LibraryEntry, row?: LibraryRow, failureId = "") => {
    if (!workspace) return;
    const current = failureId && row ? workspace.collection.get(row.clientId) : undefined;
    const input = {
      ...initial,
      ...entry,
      year: entry.year ?? "",
      scope: workspace.scope,
      clientId: row && (!failureId || (current && !current.deleted)) ? row.clientId : "",
      expectedRevision: row
        ? failureId
          ? current && !current.deleted
            ? current.revision
            : 0
          : row.revision
        : 0,
      failureId,
    };
    const baselineEntry =
      current && !current.deleted
        ? (workspace.read(current).entry ?? emptyLibraryEntry)
        : failureId
          ? emptyLibraryEntry
          : (row?.entry ?? emptyLibraryEntry);
    const baseline = { ...input, ...baselineEntry, year: baselineEntry.year ?? "" };
    form.setInitialValues(baseline);
    form.setValues(input);
    form.resetDirty(baseline);
    form.clearErrors();
    editor.open();
  };
  const save = useMutation({
    mutationKey: ["library-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof initial) => {
      if (!workspace || input.scope !== workspace.scope) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.save({
        clientId: input.clientId || crypto.randomUUID(),
        expectedRevision: input.expectedRevision,
        action: input.clientId ? "update" : "create",
        entry: values(input),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      if (
        form.getValues().scope === input.scope &&
        form.getValues().clientId === input.clientId &&
        form.getValues().expectedRevision === input.expectedRevision
      ) {
        form.reset();
        editor.close();
      }
      void status.refetch();
    },
  });
  const remove = useMutation({
    mutationKey: ["library-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (row: LibraryRow) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.save({
        clientId: row.clientId,
        expectedRevision: row.revision,
        action: "delete",
      });
    },
    onSuccess: (_result, row) => {
      if (
        form.getValues().clientId === row.clientId &&
        form.getValues().scope === workspace?.scope
      ) {
        form.setInitialValues(initial);
        form.setValues(initial);
        form.resetDirty(initial);
        editor.close();
      }
      void status.refetch();
    },
  });
  const restore = useMutation({
    mutationKey: ["library-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedLibraryAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.read(failure.envelope);
      if (!row.entry) throw new Error("LIBRARY_ITEM_DELETED");
      assign(row.entry, row, failure.id);
    },
  });
  const importPublication = useMutation({
    mutationKey: ["library-import"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (record: MedicalRecord) => {
      const previous = matchingPublication(rows, record);
      assign(publicationEntry(record, previous?.entry ?? undefined), previous);
    },
  });
  const dirty = () =>
    editing && Boolean(workspace) && form.values.scope === workspace?.scope && form.isDirty();
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: dirty,
    enableBeforeUnload: dirty,
  });
  return {
    ...space,
    catalog,
    cache,
    searchForm,
    cacheResult,
    search,
    publications,
    matches,
    filters,
    selected,
    pageCount,
    page,
    pagination,
    pageRows: selected.slice((page - 1) * 20, page * 20),
    form,
    editing,
    editor,
    save,
    remove,
    restore,
    blocker,
    add: () => assign(emptyLibraryEntry),
    edit: (row: LibraryRow) => {
      if (row.entry) assign(row.entry, row);
    },
    reviewVersion: (entry: LibraryEntry, row: LibraryRow) => assign(entry, row),
    importPublication,
    matchingPublication: (record: MedicalRecord) => matchingPublication(rows, record),
    collections: [
      ...new Set(rows.flatMap((row) => (row.entry?.collection ? [row.entry.collection] : []))),
    ].sort(),
    tags: [...new Set(rows.flatMap((row) => row.entry?.tags ?? []))].sort(),
  };
}
