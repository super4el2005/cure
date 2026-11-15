import { z } from "zod";

// Protocol visit schedule: planned visits are derived from the enrollment date.
// All calendar arithmetic uses inclusive UTC dates, matching enrollment and
// consent validation; generated visits keep 12:00 UTC as a neutral placeholder
// that the treating physician reschedules to the clinic's zone.
export const visitScheduleItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  offsetDays: z.number().int().min(0).max(3650),
  windowBeforeDays: z.number().int().min(0).max(90),
  windowAfterDays: z.number().int().min(0).max(90),
  visitType: z.enum(["consultation", "procedure", "hospitalization", "followUp"]),
  durationMinutes: z.number().int().min(1).max(1440),
});
export const visitScheduleSchema = z.array(visitScheduleItemSchema).max(50);
export type VisitScheduleItem = z.infer<typeof visitScheduleItemSchema>;

export function addDays(date: string, days: number) {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}
export function scheduledVisits(
  schedule: readonly VisitScheduleItem[],
  enrolledOn: string,
  consent: { signedOn: string; expiresOn: string },
) {
  return schedule
    .map((item) => {
      const scheduledDate = addDays(enrolledOn, item.offsetDays);
      return {
        item,
        scheduledDate,
        scheduledFor: `${scheduledDate}T12:00:00+00:00[UTC]`,
        windowFrom: addDays(enrolledOn, item.offsetDays - item.windowBeforeDays),
        windowTo: addDays(enrolledOn, item.offsetDays + item.windowAfterDays),
      };
    })
    .filter(
      (visit) =>
        visit.scheduledDate >= consent.signedOn && visit.scheduledDate <= consent.expiresOn,
    );
}
