import { z } from "zod";

import { projectRoleSchema, researchStatusSchema } from "@/src/lib/research-model";

export const invitedRoleSchema = z.enum(["coordinator", "member", "viewer"]);
export type InvitedRole = z.infer<typeof invitedRoleSchema>;
const common = {
  key: z.string().min(1),
  clientId: z.string().min(1),
  projectClientId: z.uuid(),
  revision: z.number().int().positive(),
  delivery: z.enum(["local", "confirmed"]),
};
export const teamRecordSchema = z.discriminatedUnion("entity", [
  z.object({
    ...common,
    entity: z.literal("member"),
    userId: z.string(),
    role: projectRoleSchema,
    active: z.boolean(),
    displayName: z.string(),
    organization: z.string(),
  }),
  z.object({
    ...common,
    entity: z.literal("invitation"),
    inviteeId: z.string(),
    inviterId: z.string(),
    targetProfileId: z.string(),
    inviteeName: z.string(),
    projectTitle: z.string(),
    projectStatus: researchStatusSchema.nullable(),
    role: invitedRoleSchema,
    status: z.enum(["pending", "accepted", "declined", "revoked"]),
    expiresAt: z.number(),
  }),
]);
export type TeamRecord = z.infer<typeof teamRecordSchema>;
export const teamOperationSchema = z.enum(["invite", "respond", "revokeInvite", "setMember"]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;
export const teamCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("invite"),
    clientId: z.uuid(),
    projectClientId: z.uuid(),
    targetProfileId: z.string().min(1),
    inviteeName: z.string().max(150),
    role: invitedRoleSchema,
  }),
  z.object({
    operation: z.literal("respond"),
    key: z.string(),
    decision: z.enum(["accept", "decline"]),
  }),
  z.object({ operation: z.literal("revokeInvite"), key: z.string() }),
  z.object({
    operation: z.literal("setMember"),
    key: z.string(),
    role: invitedRoleSchema,
    active: z.boolean(),
  }),
]);
export type TeamCommand = z.infer<typeof teamCommandSchema>;
