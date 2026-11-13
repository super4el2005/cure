import { z } from "zod";

export const consentEventSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    kind: z.enum(["granted", "withdrawn"]),
    purpose: z.string().trim().min(1).max(1000),
    recipients: z.array(z.string().min(1).max(200)).min(1).max(50),
    scope: z
      .array(z.enum(["sex", "diagnoses"]))
      .min(1)
      .max(2),
    expiresAt: z.number().finite().positive(),
    recordedAt: z.number().finite().positive(),
    recordedBy: z.string().min(1).max(200),
    documentReference: z.string().trim().min(1).max(1000),
  })
  .refine(
    (event) =>
      new Set(event.recipients).size === event.recipients.length &&
      new Set(event.scope).size === event.scope.length,
  );
export type ConsentEvent = z.infer<typeof consentEventSchema>;
export function validateConsentTransition(
  previous: ConsentEvent[],
  next: ConsentEvent[],
  actorId: string,
  now: number,
): ConsentEvent | undefined {
  const oldResult = z.array(consentEventSchema).safeParse(previous);
  const nextResult = z.array(consentEventSchema).safeParse(next);
  if (!oldResult.success || !nextResult.success) throw new Error("INVALID_CONSENT");
  const old = oldResult.data;
  const updated = nextResult.data;
  if (
    updated.length < old.length ||
    updated.length > old.length + 1 ||
    old.some((event, index) => JSON.stringify(event) !== JSON.stringify(updated[index]))
  )
    throw new Error("CONSENT_HISTORY_IMMUTABLE");
  if (updated.length === old.length) return undefined;
  const event = updated.at(-1)!;
  if (
    event.version !== old.length + 1 ||
    old.some((item) => item.id === event.id) ||
    event.recordedBy !== actorId ||
    event.recordedAt > now + 5 * 60 * 1000
  )
    throw new Error("INVALID_CONSENT");
  if (
    event.kind === "granted" &&
    (event.expiresAt <= now || event.expiresAt > now + 366 * 86400000)
  )
    throw new Error("CONSENT_EXPIRED");
  if (event.kind === "withdrawn" && old.at(-1)?.kind !== "granted")
    throw new Error("INVALID_CONSENT");
  return event;
}
export function activeResearchConsent(
  history: ConsentEvent[] | undefined,
  recipient: string,
  now: number,
) {
  const latest = consentEventSchema.safeParse(history?.at(-1));
  if (
    !latest.success ||
    latest.data.kind !== "granted" ||
    latest.data.expiresAt <= now ||
    !latest.data.recipients.includes(recipient)
  )
    return undefined;
  return latest.data;
}
