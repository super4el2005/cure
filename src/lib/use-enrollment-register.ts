import { useForm } from "@mantine/form";
import { usePagination } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";

import { enrollmentRegister, filterEnrollmentRegister } from "@/src/lib/enrollment-register";
import { enrollmentStatusSchema } from "@/src/lib/study-enrollment-model";
import type { EnrollmentStatus } from "@/src/lib/study-enrollment-model";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

export function useEnrollmentRegister(projectId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, rows: patients } = space;
  const source = useLiveQuery(() => workspace?.clinicalRecords);
  const records =
    workspace && opened?.role === "doctor" && Date.now() < workspace.expiresAt
      ? (source.data ?? [])
          .filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              return [workspace.readClinical(envelope)];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          })
      : [];
  const all = enrollmentRegister(
    patients,
    records,
    projectId,
    opened?.role ?? "researcher",
    Date.now(),
  );
  const filters = useForm({
    initialValues: { query: "", statuses: [] as EnrollmentStatus[], expiredOnly: false },
  });
  const selected = filterEnrollmentRegister(all, patients, filters.values, Date.now());
  const pageCount = Math.max(1, Math.ceil(selected.length / 25));
  const pagination = usePagination({ total: pageCount });
  const page = Math.min(pagination.active, pageCount);
  return {
    ...space,
    source,
    all,
    selected,
    filters,
    page,
    pageCount,
    pagination,
    pageRows: selected.slice((page - 1) * 25, page * 25),
    counts: enrollmentStatusSchema.options.map((status) => ({
      status,
      count: all.filter((row) => row.status === status).length,
    })),
  };
}
