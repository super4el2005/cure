import { useLingui } from "@lingui/react/macro";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";

import type { ClinicalPayload, ClinicalRecord } from "@/src/lib/clinical-record-model";
import { clinicalPayloadSchema } from "@/src/lib/clinical-record-model";
import type { FailedPatientAction } from "@/src/lib/patient-workspace";
import { usePatientWorkspace } from "@/src/lib/use-patient-workspace";

const initialValues = {
  clientId: "",
  patientClientId: "",
  expectedRevision: 0,
  failureId: "",
  kind: "history" as ClinicalPayload["kind"],
  occurredOn: null as string | null,
  notes: "",
  text: "",
  substance: "",
  reaction: "",
  severity: "unknown" as "unknown" | "mild" | "moderate" | "severe",
  allergyStatus: "active" as "active" | "inactive",
  drug: "",
  code: "",
  dosage: "",
  route: "",
  endedOn: null as string | null,
  medicationStatus: "active" as "active" | "completed" | "stopped",
  name: "",
  resultType: "numeric" as "numeric" | "text",
  numericValue: "" as number | string,
  textValue: "",
  unit: "",
};
function payload(values: typeof initialValues) {
  const common = { occurredOn: values.occurredOn ?? "", notes: values.notes };
  switch (values.kind) {
    case "history":
      return { ...common, kind: values.kind, text: values.text };
    case "allergy":
      return {
        ...common,
        kind: values.kind,
        substance: values.substance,
        reaction: values.reaction,
        severity: values.severity,
        status: values.allergyStatus,
      };
    case "medication":
      return {
        ...common,
        kind: values.kind,
        drug: values.drug,
        code: values.code,
        dosage: values.dosage,
        route: values.route,
        endedOn: values.endedOn ?? "",
        status: values.medicationStatus,
      };
    case "observation":
      return {
        ...common,
        kind: values.kind,
        name: values.name,
        code: values.code,
        numericValue:
          values.resultType === "numeric" && typeof values.numericValue === "number"
            ? values.numericValue
            : null,
        textValue: values.resultType === "text" ? values.textValue : "",
        unit: values.unit,
      };
  }
}
export function useClinicalRecords(patientId: string) {
  const space = usePatientWorkspace();
  const { workspace, opened, status } = space;
  const { t } = useLingui();
  const localClinical = useLiveQuery(() => workspace?.clinicalRecords);
  const clinical =
    opened?.role === "doctor" && workspace
      ? (localClinical.data
          ?.filter((row) => row.clientId !== workspace.clinicalSnapshotId && !row.deleted)
          .flatMap((envelope) => {
            try {
              const row = workspace.readClinical(envelope);
              return row.patientClientId === patientId ? [row] : [];
            } catch (error) {
              if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return [];
              throw error;
            }
          })
          .sort(
            (a, b) =>
              (b.payload?.occurredOn ?? "").localeCompare(a.payload?.occurredOn ?? "") ||
              b.updatedAt - a.updatedAt,
          ) ?? [])
      : [];
  const [clinicalEditing, clinicalEditor] = useDisclosure(false);
  const clinicalForm = useForm({
    initialValues,
    validate: (values) => {
      const result = clinicalPayloadSchema.safeParse(payload(values));
      return result.success
        ? {}
        : Object.fromEntries(
            result.error.issues.map((issue) => {
              const field = String(issue.path[0] ?? "notes");
              return [
                field === "status"
                  ? values.kind === "allergy"
                    ? "allergyStatus"
                    : "medicationStatus"
                  : field,
                t`Проверьте значение поля`,
              ];
            }),
          );
    },
  });
  const clinicalFailures = useQuery({
    queryKey: ["clinical-failures", workspace?.scope, patientId],
    enabled: opened?.role === "doctor",
    networkMode: "always",
    gcTime: 0,
    refetchInterval: 2000,
    queryFn: async () =>
      (await workspace!.failedActions("clinical")).filter((failure) => {
        try {
          return workspace!.readClinical(failure.envelope).patientClientId === patientId;
        } catch (error) {
          if (error instanceof Error && error.message === "PATIENT_NOT_FOUND") return false;
          throw error;
        }
      }),
  });
  const fill = (
    record: ClinicalRecord,
    failureId = "",
    expectedRevision = record.revision,
    clientId = record.clientId,
  ) => {
    if (!record.payload) throw new Error("INVALID_CLINICAL_RECORD");
    const value = record.payload;
    clinicalForm.reset();
    clinicalForm.setValues({
      clientId,
      patientClientId: record.patientClientId,
      expectedRevision,
      failureId,
      kind: value.kind,
      occurredOn: value.occurredOn,
      notes: value.notes,
    });
    if (value.kind === "history") clinicalForm.setValues({ text: value.text });
    if (value.kind === "allergy")
      clinicalForm.setValues({
        substance: value.substance,
        reaction: value.reaction,
        severity: value.severity,
        allergyStatus: value.status,
      });
    if (value.kind === "medication")
      clinicalForm.setValues({
        drug: value.drug,
        code: value.code,
        dosage: value.dosage,
        route: value.route,
        endedOn: value.endedOn || null,
        medicationStatus: value.status,
      });
    if (value.kind === "observation")
      clinicalForm.setValues({
        name: value.name,
        code: value.code,
        resultType: value.numericValue === null ? "text" : "numeric",
        numericValue: value.numericValue ?? "",
        textValue: value.textValue,
        unit: value.unit,
      });
    clinicalEditor.open();
  };
  const saveClinical = useMutation({
    mutationKey: ["clinical-save"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (input: typeof clinicalForm.values) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const result = await workspace.saveClinical({
        clientId: input.clientId || crypto.randomUUID(),
        patientClientId: input.patientClientId,
        expectedRevision: input.expectedRevision,
        action: input.clientId ? "update" : "create",
        payload: clinicalPayloadSchema.parse(payload(input)),
      });
      if (input.failureId) await workspace.dismissFailure(input.failureId);
      return result;
    },
    onSuccess: (_result, input) => {
      const current = clinicalForm.getValues();
      if (
        current.patientClientId === input.patientClientId &&
        current.clientId === input.clientId &&
        current.expectedRevision === input.expectedRevision
      ) {
        clinicalForm.reset();
        clinicalEditor.close();
      }
      void status.refetch();
      void clinicalFailures.refetch();
    },
  });
  const deleteClinical = useMutation({
    mutationKey: ["clinical-delete"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (record: ClinicalRecord) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      return workspace.saveClinical({
        clientId: record.clientId,
        patientClientId: record.patientClientId,
        expectedRevision: record.revision,
        action: "delete",
      });
    },
    onSuccess: () => {
      void status.refetch();
      void clinicalFailures.refetch();
    },
  });
  const restoreClinical = useMutation({
    mutationKey: ["clinical-restore"],
    networkMode: "always",
    retry: false,
    gcTime: 0,
    mutationFn: async (failure: FailedPatientAction) => {
      if (!workspace) throw new Error("WORKSPACE_LOCKED");
      const row = workspace.readClinical(failure.envelope);
      const current = workspace.clinicalRecords.get(row.clientId);
      if (failure.action === "delete") throw new Error("INVALID_CLINICAL_RECORD");
      fill(
        row,
        failure.id,
        current && !current.deleted ? current.revision : 0,
        current && !current.deleted ? row.clientId : "",
      );
    },
  });
  return {
    ...space,
    localClinical,
    clinical,
    clinicalEditing,
    clinicalEditor,
    clinicalForm,
    saveClinical,
    deleteClinical,
    restoreClinical,
    clinicalFailures,
    createClinical: () => {
      clinicalForm.reset();
      clinicalForm.setValues({
        patientClientId: patientId,
        occurredOn: dayjs().format("YYYY-MM-DD"),
      });
      clinicalEditor.open();
    },
    editClinical: (record: ClinicalRecord) => fill(record),
  };
}
