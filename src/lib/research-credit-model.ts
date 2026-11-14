import { z } from "zod";

// Stable CRediT identifiers; labels belong to the interface, not persisted codes.
export const creditRoleSchema = z.enum([
  "conceptualization",
  "dataCuration",
  "formalAnalysis",
  "fundingAcquisition",
  "investigation",
  "methodology",
  "projectAdministration",
  "resources",
  "software",
  "supervision",
  "validation",
  "visualization",
  "writingOriginalDraft",
  "writingReviewEditing",
]);
const predecessor = z.uuid().nullable();
export const creditEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("declaration"),
    previousClientId: predecessor,
    roles: z
      .array(creditRoleSchema)
      .max(14)
      .refine((values) => new Set(values).size === values.length),
    contribution: z.string().trim().min(1).max(5000),
    hasInterests: z.boolean(),
    interests: z.string().trim().min(1).max(5000),
  }),
  z
    .object({
      kind: z.literal("agreement"),
      groupId: z.uuid(),
      previousClientId: predecessor,
      version: z.number().int().positive(),
      outputTitle: z.string().trim().min(1).max(300),
      terms: z.string().trim().min(1).max(10000),
      authors: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(200)
        .refine((values) => new Set(values).size === values.length),
      correspondingAuthorId: z.string().min(1).max(200),
      reason: z.string().trim().max(2000),
    })
    .superRefine((value, ctx) => {
      if (!value.authors.includes(value.correspondingAuthorId))
        ctx.addIssue({
          code: "custom",
          path: ["correspondingAuthorId"],
          message: "INVALID_AUTHORSHIP",
        });
      if (
        (value.version === 1) !== (value.previousClientId === null) ||
        (value.version > 1 && !value.reason)
      )
        ctx.addIssue({ code: "custom", path: ["reason"], message: "INVALID_AUTHORSHIP" });
    }),
  z
    .object({
      kind: z.literal("decision"),
      previousClientId: predecessor,
      agreementClientId: z.uuid(),
      declarationClientId: z.uuid(),
      decision: z.enum(["accepted", "declined"]),
      attestations: z.object({
        substantialContribution: z.boolean(),
        manuscriptWork: z.boolean(),
        finalApproval: z.boolean(),
        accountability: z.boolean(),
      }),
      comment: z.string().trim().max(3000),
    })
    .superRefine((value, ctx) => {
      if (value.decision === "accepted" && !Object.values(value.attestations).every(Boolean))
        ctx.addIssue({
          code: "custom",
          path: ["attestations"],
          message: "AUTHORSHIP_ATTESTATION_REQUIRED",
        });
      if (value.decision === "declined" && !value.comment)
        ctx.addIssue({ code: "custom", path: ["comment"], message: "DECISION_REASON_REQUIRED" });
    }),
]);
export type CreditEvent = z.infer<typeof creditEventSchema>;
export type CreditEntry = { clientId: string; createdBy: string; values: CreditEvent };
export function currentDeclaration<T extends CreditEntry>(entries: readonly T[], userId: string) {
  const chain = entries.filter(
    (row) => row.createdBy === userId && row.values.kind === "declaration",
  );
  const previous = new Set(
    chain.flatMap((row) => (row.values.previousClientId ? [row.values.previousClientId] : [])),
  );
  return chain.find((row) => !previous.has(row.clientId));
}
export function currentAgreement<T extends CreditEntry>(entries: readonly T[], groupId: string) {
  return entries.find(
    (row) =>
      row.values.kind === "agreement" &&
      row.values.groupId === groupId &&
      !entries.some(
        (other) =>
          other.values.kind === "agreement" && other.values.previousClientId === row.clientId,
      ),
  );
}
export function currentDecision<T extends CreditEntry>(
  entries: readonly T[],
  agreementClientId: string,
  userId: string,
) {
  const chain = entries.filter(
    (row) =>
      row.createdBy === userId &&
      row.values.kind === "decision" &&
      row.values.agreementClientId === agreementClientId,
  );
  const previous = new Set(
    chain.flatMap((row) => (row.values.previousClientId ? [row.values.previousClientId] : [])),
  );
  return chain.find((row) => !previous.has(row.clientId));
}
// Shared domain checks operate on the exact project and current actor. Both the
// native offline action and the Convex transaction run this validation.
export function validateCreditEvent(
  entries: readonly CreditEntry[],
  actorId: string,
  manager: boolean,
  next: CreditEvent,
) {
  if (next.kind === "declaration") {
    if ((currentDeclaration(entries, actorId)?.clientId ?? null) !== next.previousClientId)
      throw new Error("REVISION_CONFLICT");
  } else if (next.kind === "agreement") {
    if (!manager) throw new Error("ACCESS_DENIED");
    const previous = currentAgreement(entries, next.groupId);
    if (
      (previous?.clientId ?? null) !== next.previousClientId ||
      next.version !== (previous?.values.kind === "agreement" ? previous.values.version : 0) + 1
    )
      throw new Error("REVISION_CONFLICT");
  } else {
    const agreement = entries.find((row) => row.clientId === next.agreementClientId);
    if (
      agreement?.values.kind !== "agreement" ||
      currentAgreement(entries, agreement.values.groupId)?.clientId !== agreement.clientId
    )
      throw new Error("AUTHORSHIP_OUTDATED");
    if (!agreement.values.authors.includes(actorId)) throw new Error("ACCESS_DENIED");
    if (currentDeclaration(entries, actorId)?.clientId !== next.declarationClientId)
      throw new Error("DECLARATION_OUTDATED");
    if (
      (currentDecision(entries, agreement.clientId, actorId)?.clientId ?? null) !==
      next.previousClientId
    )
      throw new Error("REVISION_CONFLICT");
  }
}
