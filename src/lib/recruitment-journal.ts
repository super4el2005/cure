import type { ClinicalPayload } from "@/src/lib/clinical-record-model";
import { enrollmentStatusSchema } from "@/src/lib/study-enrollment-model";
import type { EnrollmentStatus } from "@/src/lib/study-enrollment-model";

// Cross-center recruitment overview for the research team. The result contains
// only per-center aggregates: no patient identity, dates of individual events,
// reasons or consent documents ever leave the treating clinic's rows.
export interface RecruitmentJournalRecord {
  organizationId: string;
  deleted: boolean;
  updatedAt: number;
  payload: ClinicalPayload | null;
}
export interface RecruitmentJournalCenter {
  organizationId: string;
  name: string;
  country: string;
  city: string;
  counts: Record<EnrollmentStatus, number>;
  total: number;
  consentExpired: number;
  updatedAt: number;
}
export function recruitmentJournal(
  records: readonly RecruitmentJournalRecord[],
  organizations: ReadonlyMap<string, { name: string; country: string; city: string }>,
  projectClientId: string,
  now: number,
): RecruitmentJournalCenter[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const centers = new Map<string, RecruitmentJournalCenter>();
  for (const record of records) {
    const payload = record.payload;
    if (
      record.deleted ||
      payload?.kind !== "enrollment" ||
      payload.projectClientId !== projectClientId
    )
      continue;
    let center = centers.get(record.organizationId);
    if (!center) {
      const organization = organizations.get(record.organizationId);
      center = {
        organizationId: record.organizationId,
        name: organization?.name ?? "",
        country: organization?.country ?? "",
        city: organization?.city ?? "",
        counts: {
          screening: 0,
          ineligible: 0,
          enrolled: 0,
          declined: 0,
          withdrawn: 0,
          completed: 0,
        },
        total: 0,
        consentExpired: 0,
        updatedAt: 0,
      };
      centers.set(record.organizationId, center);
    }
    const decision = payload.events.at(-1)!;
    center.counts[decision.status] += 1;
    center.total += 1;
    const consent = payload.events.findLast((event) => event.status === "enrolled")?.consent;
    if (decision.status === "enrolled" && consent && consent.expiresOn < today)
      center.consentExpired += 1;
    center.updatedAt = Math.max(center.updatedAt, record.updatedAt);
  }
  return [...centers.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.country.localeCompare(b.country) ||
      a.organizationId.localeCompare(b.organizationId),
  );
}
export function recruitmentTotals(rows: readonly RecruitmentJournalCenter[]) {
  const counts = Object.fromEntries(
    enrollmentStatusSchema.options.map((status) => [
      status,
      rows.reduce((sum, row) => sum + row.counts[status], 0),
    ]),
  ) as Record<EnrollmentStatus, number>;
  return {
    counts,
    total: rows.reduce((sum, row) => sum + row.total, 0),
    consentExpired: rows.reduce((sum, row) => sum + row.consentExpired, 0),
    centers: rows.length,
  };
}
