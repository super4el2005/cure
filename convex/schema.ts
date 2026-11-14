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
export const creditEvent = v.union(
  v.object({
    kind: v.literal("declaration"),
    previousClientId: v.union(v.string(), v.null()),
    roles: v.array(v.string()),
    contribution: v.string(),
    hasInterests: v.boolean(),
    interests: v.string(),
  }),
  v.object({
    kind: v.literal("agreement"),
    groupId: v.string(),
    previousClientId: v.union(v.string(), v.null()),
    version: v.number(),
    outputTitle: v.string(),
    terms: v.string(),
    authors: v.array(v.string()),
    correspondingAuthorId: v.string(),
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("decision"),
    previousClientId: v.union(v.string(), v.null()),
    agreementClientId: v.string(),
    declarationClientId: v.string(),
    decision: v.union(v.literal("accepted"), v.literal("declined")),
    attestations: v.object({
      substantialContribution: v.boolean(),
      manuscriptWork: v.boolean(),
      finalApproval: v.boolean(),
      accountability: v.boolean(),
    }),
    comment: v.string(),
  }),
);
const studyFieldCommon = {
  visibleWhen: v.optional(
    v.object({
      mode: v.union(v.literal("all"), v.literal("any")),
      rules: v.array(
        v.object({
          fieldId: v.string(),
          operator: v.union(
            ...(["equals", "notEquals", "includes", "gt", "gte", "lt", "lte"] as const).map(
              (value) => v.literal(value),
            ),
          ),
          value: v.union(v.string(), v.number(), v.boolean()),
        }),
      ),
    }),
  ),
  id: v.string(),
  label: v.string(),
  help: v.string(),
  required: v.boolean(),
};
const studyChoices = v.array(v.object({ value: v.string(), label: v.string() }));
export const formDefinition = v.object({
  scores: v.optional(
    v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        description: v.string(),
        unit: v.string(),
        method: v.union(v.literal("sum"), v.literal("mean")),
        terms: v.array(
          v.object({
            fieldId: v.string(),
            weight: v.number(),
            mapping: v.optional(
              v.array(v.object({ value: v.union(v.string(), v.boolean()), score: v.number() })),
            ),
          }),
        ),
      }),
    ),
  ),
  title: v.string(),
  description: v.string(),
  fields: v.array(
    v.union(
      v.object({ ...studyFieldCommon, type: v.literal("text"), maxLength: v.number() }),
      v.object({
        ...studyFieldCommon,
        type: v.literal("number"),
        minimum: v.union(v.number(), v.null()),
        maximum: v.union(v.number(), v.null()),
        unit: v.string(),
      }),
      v.object({
        ...studyFieldCommon,
        type: v.literal("date"),
        minDate: v.string(),
        maxDate: v.string(),
      }),
      v.object({ ...studyFieldCommon, type: v.literal("boolean") }),
      v.object({ ...studyFieldCommon, type: v.literal("choice"), choices: studyChoices }),
      v.object({ ...studyFieldCommon, type: v.literal("multiChoice"), choices: studyChoices }),
    ),
  ),
});
export const formStatus = v.union(v.literal("published"), v.literal("retired"));
const clinicalCommon = { occurredOn: v.string(), notes: v.string() };
export const libraryEntry = v.object({
  title: v.string(),
  doi: v.string(),
  pmid: v.string(),
  url: v.string(),
  citation: v.string(),
  authors: v.string(),
  year: v.union(v.number(), v.null()),
  collection: v.string(),
  tags: v.array(v.string()),
  notes: v.string(),
  status: v.union(
    v.literal("toRead"),
    v.literal("reading"),
    v.literal("included"),
    v.literal("excluded"),
  ),
  exclusionReason: v.string(),
  source: v.union(v.literal("manual"), v.literal("pubmed")),
  fetchedAt: v.union(v.number(), v.null()),
});
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
    kind: v.literal("studyIssue"),
    writeId: v.string(),
    projectClientId: v.string(),
    enrollmentClientId: v.string(),
    protocolClientId: v.string(),
    protocolVersion: v.number(),
    detectedOn: v.string(),
    title: v.string(),
    description: v.string(),
    status: v.union(
      v.literal("open"),
      v.literal("underReview"),
      v.literal("resolved"),
      v.literal("closed"),
    ),
    reviewerId: v.string(),
    reviewDueOn: v.string(),
    resolution: v.string(),
    reviewedOn: v.string(),
    reviewedBy: v.string(),
    amendmentReason: v.string(),
    details: v.union(
      v.object({
        type: v.literal("adverseEvent"),
        severity: v.union(v.literal("mild"), v.literal("moderate"), v.literal("severe")),
        seriousness: v.array(
          v.union(
            v.literal("death"),
            v.literal("lifeThreatening"),
            v.literal("hospitalization"),
            v.literal("disability"),
            v.literal("congenitalAnomaly"),
            v.literal("medicallyImportant"),
          ),
        ),
        causality: v.union(
          v.literal("unassessed"),
          v.literal("unrelated"),
          v.literal("possible"),
          v.literal("probable"),
          v.literal("related"),
        ),
        expectedness: v.union(v.literal("unknown"), v.literal("expected"), v.literal("unexpected")),
        suspectAgent: v.string(),
        actionTaken: v.string(),
        outcome: v.union(
          v.literal("unknown"),
          v.literal("ongoing"),
          v.literal("recovering"),
          v.literal("recovered"),
          v.literal("sequelae"),
          v.literal("fatal"),
        ),
        endedOn: v.string(),
      }),
      v.object({
        type: v.literal("deviation"),
        impact: v.union(v.literal("minor"), v.literal("major"), v.literal("critical")),
        protocolSection: v.string(),
        rootCause: v.string(),
        correctiveAction: v.string(),
        preventiveAction: v.string(),
      }),
    ),
  }),

  v.object({
    ...clinicalCommon,
    kind: v.literal("enrollment"),
    writeId: v.string(),
    projectClientId: v.string(),
    protocolClientId: v.string(),
    protocolVersion: v.number(),
    events: v.array(
      v.object({
        id: v.string(),
        status: v.union(
          v.literal("screening"),
          v.literal("ineligible"),
          v.literal("enrolled"),
          v.literal("declined"),
          v.literal("withdrawn"),
          v.literal("completed"),
        ),
        occurredOn: v.string(),
        reason: v.string(),
        recordedBy: v.string(),
        recordedAt: v.number(),
        eligibilityEvidence: v.string(),
        inclusionConfirmed: v.boolean(),
        exclusionAbsent: v.boolean(),
        consent: v.union(
          v.null(),
          v.object({
            documentReference: v.string(),
            version: v.string(),
            signedOn: v.string(),
            expiresOn: v.string(),
          }),
        ),
      }),
    ),
  }),
  v.object({
    ...clinicalCommon,
    kind: v.literal("questionnaire"),
    writeId: v.string(),
    projectClientId: v.string(),
    formVersionClientId: v.string(),
    formClientId: v.string(),
    formVersion: v.number(),
    definition: formDefinition,
    answers: v.record(
      v.string(),
      v.union(v.string(), v.number(), v.boolean(), v.array(v.string())),
    ),
    status: v.union(v.literal("draft"), v.literal("final")),
    amendmentReason: v.string(),
  }),
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
  v.object({
    ...clinicalCommon,
    kind: v.literal("studyVisit"),
    writeId: v.string(),
    enrollmentClientId: v.string(),
    enrollmentWriteId: v.string(),
    projectClientId: v.string(),
    protocolClientId: v.string(),
    protocolVersion: v.number(),
    windowFrom: v.string(),
    windowTo: v.string(),
    performedOn: v.string(),
    deviationReason: v.string(),
    amendmentReason: v.string(),
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
  studyForms: defineTable({
    baseVersionClientId: v.union(v.string(), v.null()),
    clientId: v.string(),
    formClientId: v.string(),
    projectClientId: v.string(),
    version: v.number(),
    definition: formDefinition,
    status: formStatus,
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_client", ["clientId"])
    .index("by_project", ["projectClientId"])
    .index("by_form_version", ["projectClientId", "formClientId", "version"]),
  libraryItems: defineTable({
    userId: v.string(),
    clientId: v.string(),
    writeId: v.string(),
    revision: v.number(),
    deleted: v.boolean(),
    entry: v.union(libraryEntry, v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["userId"])
    .index("by_client", ["clientId"]),
  libraryVersions: defineTable({
    userId: v.string(),
    clientId: v.string(),
    itemClientId: v.string(),
    revision: v.number(),
    entry: libraryEntry,
    recordedAt: v.number(),
    recordedBy: v.string(),
  })
    .index("by_owner", ["userId"])
    .index("by_item", ["itemClientId"]),
  libraryAudit: defineTable({
    actorId: v.string(),
    clientId: v.string(),
    revision: v.number(),
    action: v.string(),
    at: v.number(),
  }).index("by_owner", ["actorId"]),
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
  clinicalVersions: defineTable({
    organizationId: v.id("organizations"),
    clientId: v.string(),
    recordClientId: v.string(),
    patientClientId: v.string(),
    revision: v.number(),
    payload: clinicalPayload,
    recordedAt: v.number(),
    recordedBy: v.string(),
  })
    .index("by_client", ["organizationId", "clientId"])
    .index("by_organization", ["organizationId"])
    .index("by_record", ["organizationId", "recordClientId"])
    .index("by_patient", ["organizationId", "patientClientId"]),
  clinicalRecords: defineTable({
    organizationId: v.id("organizations"),
    historyId: v.optional(v.string()),
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
  projectCredits: defineTable({
    clientId: v.string(),
    projectClientId: v.string(),
    values: creditEvent,
    revision: v.number(),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_client", ["clientId"])
    .index("by_project", ["projectClientId"]),
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
