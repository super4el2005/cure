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
export const researchKind = v.union(
  v.literal("retrospective"),
  v.literal("prospective"),
  v.literal("interventional"),
  v.literal("registry"),
);
export const researchStatus = v.union(
  v.literal("draft"),
  v.literal("preparing"),
  v.literal("recruiting"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("archived"),
);
export const projectRole = v.union(
  v.literal("owner"),
  v.literal("coordinator"),
  v.literal("member"),
  v.literal("viewer"),
);
export const projectFields = {
  title: v.string(),
  summary: v.string(),
  topic: v.string(),
  kind: researchKind,
  status: researchStatus,
  published: v.boolean(),
  publicEligibility: v.string(),
  publicContact: v.string(),
};
export const protocolFields = {
  hypothesis: v.string(),
  inclusion: v.string(),
  exclusion: v.string(),
  endpoints: v.string(),
  analysisPlan: v.string(),
  ethicsApproved: v.boolean(),
  ethicsReference: v.string(),
  ethicsExpiresAt: v.number(),
};
export const taskFields = {
  title: v.string(),
  description: v.string(),
  status: v.union(
    v.literal("todo"),
    v.literal("inProgress"),
    v.literal("done"),
    v.literal("cancelled"),
  ),
  priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high")),
  assigneeId: v.string(),
  dueAt: v.number(),
  archived: v.boolean(),
};
const clinicalCommon = { occurredOn: v.string(), notes: v.string() };
export const analysisValues = v.object({
  title: v.string(),
  description: v.string(),
  criteria: v.object({
    include: v.array(v.string()),
    exclude: v.array(v.string()),
    diagnosisMatch: v.union(v.literal("any"), v.literal("all")),
    sex: v.union(v.literal("any"), v.literal("female"), v.literal("male"), v.literal("unknown")),
  }),
});
export const clinicalPayload = v.union(
  v.object({
    ...clinicalCommon,
    kind: v.literal("visit"),
    scheduledFor: v.string(),
    durationMinutes: v.number(),
    visitType: v.union(
      v.literal("consultation"),
      v.literal("procedure"),
      v.literal("hospitalization"),
      v.literal("followUp"),
    ),
    status: v.union(
      v.literal("planned"),
      v.literal("inProgress"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("noShow"),
    ),
    reason: v.string(),
    location: v.string(),
    outcome: v.string(),
    followUpOn: v.string(),
    cancellationReason: v.string(),
  }),
  v.object({ ...clinicalCommon, kind: v.literal("history"), text: v.string() }),
  v.object({
    ...clinicalCommon,
    kind: v.literal("allergy"),
    substance: v.string(),
    reaction: v.string(),
    severity: v.union(
      v.literal("unknown"),
      v.literal("mild"),
      v.literal("moderate"),
      v.literal("severe"),
    ),
    status: v.union(v.literal("active"), v.literal("inactive")),
  }),
  v.object({
    ...clinicalCommon,
    kind: v.literal("medication"),
    drug: v.string(),
    code: v.string(),
    dosage: v.string(),
    route: v.string(),
    endedOn: v.string(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("stopped")),
  }),
  v.object({
    ...clinicalCommon,
    kind: v.literal("observation"),
    name: v.string(),
    code: v.string(),
    numericValue: v.union(v.number(), v.null()),
    textValue: v.string(),
    unit: v.string(),
  }),
);
export default defineSchema({
  savedAnalyses: defineTable({
    organizationId: v.id("organizations"),
    userId: v.string(),
    clientId: v.string(),
    revision: v.number(),
    deleted: v.boolean(),
    values: v.union(analysisValues, v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["organizationId", "userId"])
    .index("by_client", ["organizationId", "clientId"]),
  analysisAudit: defineTable({
    organizationId: v.id("organizations"),
    actorId: v.string(),
    clientId: v.string(),
    revision: v.number(),
    action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
    at: v.number(),
  }).index("by_owner", ["organizationId", "actorId"]),
  clinicalRecords: defineTable({
    organizationId: v.id("organizations"),
    clientId: v.string(),
    patientClientId: v.string(),
    payload: v.union(clinicalPayload, v.null()),
    revision: v.number(),
    deleted: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_client", ["organizationId", "clientId"])
    .index("by_patient_active", ["organizationId", "patientClientId", "deleted"]),
  clinicalAudit: defineTable({
    organizationId: v.id("organizations"),
    patientClientId: v.string(),
    recordClientId: v.string(),
    actorId: v.string(),
    action: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("patient-delete"),
    ),
    revision: v.number(),
    at: v.number(),
  }).index("by_patient", ["organizationId", "patientClientId"]),
  projectTasks: defineTable({
    clientId: v.string(),
    projectClientId: v.string(),
    ...taskFields,
    revision: v.number(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_project", ["projectClientId"]),
  projectMessages: defineTable({
    clientId: v.string(),
    projectClientId: v.string(),
    body: v.string(),
    deleted: v.boolean(),
    revision: v.number(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_project", ["projectClientId"]),
  projects: defineTable({
    clientId: v.string(),
    organizationId: v.id("organizations"),
    ...projectFields,
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    createdBy: v.string(),
    updatedBy: v.string(),
  })
    .index("by_client", ["clientId"])
    .index("by_public_created", ["published", "createdAt"])
    .index("by_organization", ["organizationId"]),
  projectMembers: defineTable({
    clientId: v.string(),
    projectClientId: v.string(),
    userId: v.string(),
    organizationId: v.id("organizations"),
    role: projectRole,
    active: v.boolean(),
    revision: v.number(),
  })
    .index("by_project_user", ["projectClientId", "userId"])
    .index("by_user", ["userId"])
    .index("by_project", ["projectClientId"]),
  studyProtocols: defineTable({
    clientId: v.string(),
    projectClientId: v.string(),
    version: v.number(),
    ...protocolFields,
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_project_version", ["projectClientId", "version"])
    .index("by_client", ["clientId"]),
  collaborationInvites: defineTable({
    projectTitle: v.optional(v.string()),
    clientId: v.string(),
    projectClientId: v.string(),
    inviteeId: v.string(),
    inviterId: v.string(),
    role: v.union(v.literal("coordinator"), v.literal("member"), v.literal("viewer")),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("revoked"),
    ),
    expiresAt: v.number(),
    revision: v.number(),
    createdAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_recipient", ["inviteeId"])
    .index("by_project", ["projectClientId"]),
  workspaceReceipts: defineTable({
    userId: v.string(),
    idempotencyKey: v.string(),
    fingerprint: v.string(),
    revision: v.number(),
    at: v.number(),
  }).index("by_owner_key", ["userId", "idempotencyKey"]),
  researchAudit: defineTable({
    projectClientId: v.string(),
    actorId: v.string(),
    action: v.string(),
    entityClientId: v.string(),
    revision: v.number(),
    at: v.number(),
  }).index("by_project", ["projectClientId"]),
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
