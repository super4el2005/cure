import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const profession = v.union(v.literal("doctor"), v.literal("researcher"));
export const membershipRole = v.union(profession, v.literal("admin"));
export const consentEventFields = {
  id: v.string(),
  version: v.number(),
  kind: v.union(v.literal("granted"), v.literal("withdrawn")),
  purpose: v.string(),
  recipients: v.array(v.string()),
  scope: v.array(v.union(v.literal("sex"), v.literal("diagnoses"))),
  expiresAt: v.number(),
  recordedAt: v.number(),
  recordedBy: v.string(),
  documentReference: v.string(),
};
export const patientFields = {
  consentHistory: v.optional(v.array(v.object(consentEventFields))),
  fullName: v.string(),
  birthDate: v.string(),
  sex: v.union(v.literal("female"), v.literal("male"), v.literal("unknown")),
  diagnosisCodes: v.array(v.string()),
  notes: v.string(),
};
export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    kind: v.union(
      v.literal("clinic"),
      v.literal("university"),
      v.literal("hospital"),
      v.literal("laboratory"),
    ),
    country: v.string(),
    city: v.string(),
    description: v.string(),
    published: v.boolean(),
  }).index("by_published", ["published"]),
  profiles: defineTable({
    userId: v.string(),
    displayName: v.string(),
    profession,
    specialty: v.string(),
    interests: v.array(v.string()),
    languages: v.array(v.string()),
    bio: v.string(),
    verified: v.boolean(),
    published: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_public", ["published", "verified"]),
  memberships: defineTable({
    userId: v.string(),
    organizationId: v.id("organizations"),
    role: membershipRole,
    active: v.boolean(),
    verified: v.boolean(),
  })
    .index("by_user", ["userId"])
    .index("by_organization_user", ["organizationId", "userId"]),
  patients: defineTable({
    clientId: v.string(),
    organizationId: v.id("organizations"),
    ...patientFields,
    revision: v.number(),
    updatedAt: v.number(),
    updatedBy: v.string(),
    deleted: v.boolean(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_client", ["organizationId", "clientId"]),
  patientGrants: defineTable({
    organizationId: v.id("organizations"),
    patientClientId: v.string(),
    userId: v.string(),
    expiresAt: v.number(),
    active: v.boolean(),
    consentVersion: v.optional(v.number()),
  }).index("by_patient_user", ["organizationId", "patientClientId", "userId"]),
  operationReceipts: defineTable({
    userId: v.string(),
    idempotencyKey: v.string(),
    organizationId: v.id("organizations"),
    clientId: v.string(),
    fingerprint: v.string(),
    revision: v.number(),
    completedAt: v.number(),
  }).index("by_owner_key", ["userId", "idempotencyKey"]),
  patientAudit: defineTable({
    organizationId: v.id("organizations"),
    patientClientId: v.string(),
    actorId: v.string(),
    action: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("consent-granted"),
      v.literal("consent-withdrawn"),
    ),
    revision: v.number(),
    at: v.number(),
  }).index("by_patient", ["organizationId", "patientClientId"]),
});
