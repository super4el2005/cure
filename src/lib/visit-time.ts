import {
  parseDateTime,
  parseZonedDateTime,
  toCalendarDate,
  toCalendarDateTime,
  toZoned,
} from "@internationalized/date";
import { z } from "zod";

// Keep the clinician's wall time, IANA zone and chosen UTC offset together.
export const visitTimeSchema = z
  .string()
  .max(200)
  .superRefine((value, ctx) => {
    try {
      if (!/[+-]\d{2}:\d{2}\[[^\]]+\]$/.test(value)) throw new Error("OFFSET_REQUIRED");
      parseZonedDateTime(value, "reject");
    } catch {
      ctx.addIssue({ code: "custom", message: "INVALID_VISIT_TIME" });
    }
  });
export function resolveVisitTime(
  value: string,
  timeZone: string,
  disambiguation: "reject" | "earlier" | "later" = "reject",
) {
  try {
    const local = parseDateTime(value.replace(" ", "T"));
    const earlier = toZoned(local, timeZone, "earlier");
    const later = toZoned(local, timeZone, "later");
    // Library disambiguation also shifts nonexistent spring-forward times.
    // Visits must retain the explicitly entered time rather than silently shift.
    if (
      toCalendarDateTime(earlier).compare(local) !== 0 ||
      toCalendarDateTime(later).compare(local) !== 0
    )
      throw new Error("NONEXISTENT_VISIT_TIME");
    if (earlier.compare(later) !== 0 && disambiguation === "reject")
      throw new Error("AMBIGUOUS_VISIT_TIME");
    return (disambiguation === "later" ? later : earlier).toString();
  } catch (error) {
    if (
      error instanceof Error &&
      ["NONEXISTENT_VISIT_TIME", "AMBIGUOUS_VISIT_TIME"].includes(error.message)
    )
      throw error;
    // Date-library errors include entered values; expose only the safe code.
    // eslint-disable-next-line preserve-caught-error -- Do not attach entered clinical values to application errors.
    throw new Error("INVALID_VISIT_TIME");
  }
}
export function visitTime(value: string) {
  const zoned = parseZonedDateTime(visitTimeSchema.parse(value), "reject");
  return {
    epoch: zoned.toDate().getTime(),
    timeZone: zoned.timeZone,
    date: toCalendarDate(zoned).toString(),
    local: toCalendarDateTime(zoned).toString().replace("T", " "),
  };
}
