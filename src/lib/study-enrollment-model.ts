import { z } from "zod";

export const enrollmentStatusSchema = z.enum([
  "screening",
  "ineligible",
  "enrolled",
  "declined",
  "withdrawn",
  "completed",
]);
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;
export const enrollmentTransitions: Record<EnrollmentStatus, readonly EnrollmentStatus[]> = {
  screening: ["ineligible", "enrolled", "declined"],
  enrolled: ["withdrawn", "completed"],
  ineligible: [],
  declined: [],
  withdrawn: [],
  completed: [],
};
export const participationConsentSchema = z
  .object({
    documentReference: z.string().trim().min(1).max(1000),
    version: z.string().trim().min(1).max(100),
    signedOn: z.iso.date(),
    expiresOn: z.iso.date(),
  })
  .refine((value) => value.expiresOn >= value.signedOn);
export const enrollmentEventSchema = z
  .object({
    id: z.uuid(),
    status: enrollmentStatusSchema,
    occurredOn: z.iso.date(),
    reason: z.string().trim().min(1).max(2000),
    recordedBy: z.string().min(1).max(200),
    recordedAt: z.number().finite().positive(),
    eligibilityEvidence: z.string().trim().max(5000),
    inclusionConfirmed: z.boolean(),
    exclusionAbsent: z.boolean(),
    consent: participationConsentSchema.nullable(),
  })
  .superRefine((event, ctx) => {
    if (
      event.status === "enrolled" &&
      (!event.inclusionConfirmed ||
        !event.exclusionAbsent ||
        !event.eligibilityEvidence ||
        !event.consent ||
        event.consent.signedOn > event.occurredOn ||
        event.consent.expiresOn < event.occurredOn)
    )
      ctx.addIssue({
        code: "custom",
        message: "PARTICIPATION_CONSENT_REQUIRED",
        path: ["consent"],
      });
    if (event.status !== "enrolled" && event.consent !== null)
      ctx.addIssue({ code: "custom", message: "INVALID_ENROLLMENT", path: ["consent"] });
  });
export const enrollmentPayloadSchema = z
  .object({
    kind: z.literal("enrollment"),
    writeId: z.uuid(),
    occurredOn: z.iso.date(),
    notes: z.string().trim().max(2000),
    projectClientId: z.uuid(),
    protocolClientId: z.uuid(),
    protocolVersion: z.number().int().positive(),
    events: z.array(enrollmentEventSchema).min(1).max(100),
  })
  .superRefine((value, ctx) => {
    if (
      value.events[0]?.status !== "screening" ||
      value.events[0]?.occurredOn !== value.occurredOn ||
      new Set(value.events.map((event) => event.id)).size !== value.events.length
    )
      ctx.addIssue({ code: "custom", message: "INVALID_ENROLLMENT", path: ["events"] });
    for (let i = 1; i < value.events.length; i++) {
      const previous = value.events[i - 1]!;
      const next = value.events[i]!;
      if (
        !enrollmentTransitions[previous.status].includes(next.status) ||
        next.occurredOn < previous.occurredOn ||
        next.recordedAt < previous.recordedAt
      )
        ctx.addIssue({
          code: "custom",
          message: "INVALID_ENROLLMENT_TRANSITION",
          path: ["events", i],
        });
    }
  });
export type EnrollmentPayload = z.infer<typeof enrollmentPayloadSchema>;
export function validateEnrollmentChange(
  previous: EnrollmentPayload | null,
  next: EnrollmentPayload,
  actorId: string,
  now: number,
) {
  const old = previous ? enrollmentPayloadSchema.parse(previous) : null;
  const value = enrollmentPayloadSchema.parse(next);
  if (
    old &&
    (old.projectClientId !== value.projectClientId ||
      old.protocolClientId !== value.protocolClientId ||
      old.protocolVersion !== value.protocolVersion ||
      old.occurredOn !== value.occurredOn ||
      old.notes !== value.notes)
  )
    throw new Error("ENROLLMENT_BINDING_IMMUTABLE");
  if (
    value.events.length !== (old?.events.length ?? 0) + 1 ||
    old?.events.some(
      (event, index) => JSON.stringify(event) !== JSON.stringify(value.events[index]),
    )
  )
    throw new Error("ENROLLMENT_HISTORY_IMMUTABLE");
  const event = value.events.at(-1)!;
  if (
    event.recordedBy !== actorId ||
    event.recordedAt > now + 300000 ||
    event.occurredOn > new Date(now).toISOString().slice(0, 10)
  )
    throw new Error("INVALID_ENROLLMENT");
  if (
    event.status === "enrolled" &&
    event.consent!.expiresOn < new Date(now).toISOString().slice(0, 10)
  )
    throw new Error("PARTICIPATION_CONSENT_EXPIRED");
  return event;
}
