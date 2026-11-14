import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { TaskValues } from "@/src/lib/project-work-model";
import {
  creditEventSchema,
  currentAgreement,
  currentDeclaration,
  currentDecision,
  validateCreditEvent,
} from "@/src/lib/research-credit-model";
import type { CreditEvent } from "@/src/lib/research-credit-model";
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/projectWork.ts": () => import("@/convex/projectWork"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "University",
    kind: "university",
    country: "RU",
    city: "",
    description: "",
    published: true,
  });
  for (const userId of ["owner", "member", "other", "viewer", "outsider"])
    await t.mutation(internal.provisioning.approveMembership, {
      userId,
      organizationId,
      role: "researcher",
    });
  const projectClientId = crypto.randomUUID();
  const owner = t.withIdentity({ subject: "owner" });
  const projectValues = {
    title: "Research",
    summary: "",
    topic: "",
    kind: "retrospective" as const,
    status: "draft" as const,
    published: false,
    publicEligibility: "",
    publicContact: "",
  };
  await owner.mutation(api.projects.apply, {
    actorId: "owner",
    clientId: projectClientId,
    organizationId,
    expectedRevision: 0,
    idempotencyKey: "project",
    values: projectValues,
  });
  await t.run(async (ctx) => {
    for (const userId of ["member", "other", "viewer"])
      await ctx.db.insert("projectMembers", {
        clientId: `${userId}-membership`,
        projectClientId,
        userId,
        organizationId,
        role: userId === "viewer" ? "viewer" : "member",
        active: true,
        revision: 1,
      });
  });
  const values: TaskValues = {
    title: "Private assignment",
    description: "Private methodology",
    status: "todo",
    priority: "high",
    assigneeId: "member",
    dueAt: Date.now() + 86400000,
    archived: false,
  };
  return {
    t,
    owner,
    organizationId,
    projectClientId,
    projectValues,
    values,
    member: t.withIdentity({ subject: "member" }),
  };
}

const declaration = (
  previousClientId: string | null = null,
): Extract<CreditEvent, { kind: "declaration" }> => ({
  kind: "declaration",
  previousClientId,
  roles: ["methodology", "formalAnalysis"],
  contribution: "Private contribution description",
  hasInterests: false,
  interests: "Private explicit no interests statement",
});
const attestations = {
  substantialContribution: true,
  manuscriptWork: true,
  finalApproval: true,
  accountability: true,
};
describe("research contributions and authorship", () => {
  it("requires explicit personal attestations and unique roles/authors", () => {
    expect(
      creditEventSchema.safeParse({ ...declaration(), roles: ["methodology", "methodology"] })
        .success,
    ).toBe(false);
    expect(creditEventSchema.safeParse({ ...declaration(), interests: "" }).success).toBe(false);
    const decision = {
      kind: "decision",
      previousClientId: null,
      agreementClientId: crypto.randomUUID(),
      declarationClientId: crypto.randomUUID(),
      decision: "accepted",
      comment: "",
      attestations,
    };
    expect(creditEventSchema.safeParse(decision).success).toBe(true);
    expect(
      creditEventSchema.safeParse({
        ...decision,
        attestations: { ...attestations, finalApproval: false },
      }).success,
    ).toBe(false);
    expect(creditEventSchema.safeParse({ ...decision, decision: "declined" }).success).toBe(false);
  });
  it("checks actor, team/organization authority, immutable events, predecessors and private audit", async () => {
    const { t, owner, member, organizationId, projectClientId } = await setup();
    const args = {
      actorId: "owner",
      clientId: crypto.randomUUID(),
      projectClientId,
      values: declaration(),
      idempotencyKey: "declaration",
    };
    await owner.mutation(api.projectWork.appendCredit, args);
    expect(await owner.mutation(api.projectWork.appendCredit, args)).toEqual({ revision: 1 });
    await expect(member.mutation(api.projectWork.appendCredit, args)).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    for (const actorId of ["viewer", "outsider"])
      await expect(
        t.withIdentity({ subject: actorId }).mutation(api.projectWork.appendCredit, {
          ...args,
          actorId,
          clientId: crypto.randomUUID(),
          idempotencyKey: actorId,
        }),
      ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      owner.mutation(api.projectWork.appendCredit, {
        ...args,
        values: { ...declaration(), contribution: "Changed" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(
      owner.mutation(api.projectWork.appendCredit, {
        ...args,
        clientId: crypto.randomUUID(),
        idempotencyKey: "fork",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const revised = {
      ...args,
      clientId: crypto.randomUUID(),
      values: declaration(args.clientId),
      idempotencyKey: "revised",
    };
    await owner.mutation(api.projectWork.appendCredit, revised);
    expect(
      await owner.query(api.projectWork.workspace, { actorId: "owner", organizationId }),
    ).toHaveLength(2);
    await t.run(async (ctx) => {
      const affiliation = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", "owner"),
        )
        .unique();
      await ctx.db.patch(affiliation!._id, { active: false });
    });
    await expect(owner.mutation(api.projectWork.appendCredit, args)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    const audit = await t.run((ctx) => ctx.db.query("researchAudit").collect());
    expect(JSON.stringify(audit)).not.toMatch(/Private|interests|methodology/);
  });
  it("binds each personal decision to the current agreement and declaration while retaining version history", async () => {
    const { t, owner, member, projectClientId } = await setup();
    const append = async (actorId: string, values: CreditEvent) => {
      const args = {
        actorId,
        projectClientId,
        clientId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        values,
      };
      await t.withIdentity({ subject: actorId }).mutation(api.projectWork.appendCredit, args);
      return args;
    };
    const d = await append("member", declaration());
    const agreement: Extract<CreditEvent, { kind: "agreement" }> = {
      kind: "agreement",
      groupId: crypto.randomUUID(),
      previousClientId: null,
      version: 1,
      outputTitle: "Private manuscript",
      terms: "Private version 1 final draft",
      authors: ["owner", "member"],
      correspondingAuthorId: "member",
      reason: "",
    };
    await expect(append("member", agreement)).rejects.toThrow("ACCESS_DENIED");
    await expect(append("owner", { ...agreement, authors: ["owner", "viewer"] })).rejects.toThrow(
      "INVALID_RESEARCH_CREDIT",
    );
    await expect(
      append("owner", {
        ...agreement,
        authors: ["owner", "viewer"],
        correspondingAuthorId: "owner",
      }),
    ).rejects.toThrow("AUTHOR_UNAVAILABLE");
    const a = await append("owner", agreement);
    const decision: Extract<CreditEvent, { kind: "decision" }> = {
      kind: "decision",
      agreementClientId: a.clientId,
      declarationClientId: d.clientId,
      previousClientId: null,
      decision: "accepted",
      comment: "",
      attestations,
    };
    await expect(append("owner", decision)).rejects.toThrow("DECLARATION_OUTDATED");
    const accepted = await append("member", decision);
    await expect(append("member", decision)).rejects.toThrow("REVISION_CONFLICT");
    await append("member", {
      ...decision,
      previousClientId: accepted.clientId,
      decision: "declined",
      comment: "Disagree with order",
    });
    const nextDeclaration = await append("member", declaration(d.clientId));
    await expect(
      append("member", { ...decision, previousClientId: accepted.clientId }),
    ).rejects.toThrow("DECLARATION_OUTDATED");
    const next = await append("owner", {
      ...agreement,
      previousClientId: a.clientId,
      version: 2,
      reason: "Updated order",
      authors: ["member", "owner"],
    });
    await expect(
      append("member", { ...decision, declarationClientId: nextDeclaration.clientId }),
    ).rejects.toThrow("AUTHORSHIP_OUTDATED");
    await append("member", {
      ...decision,
      agreementClientId: next.clientId,
      declarationClientId: nextDeclaration.clientId,
    });
    const rows = await t.run((ctx) => ctx.db.query("projectCredits").collect());
    const entries = rows.map((row) => ({ ...row, values: creditEventSchema.parse(row.values) }));
    expect(currentAgreement(entries, agreement.groupId)?.clientId).toBe(next.clientId);
    expect(currentDeclaration(entries, "member")?.clientId).toBe(nextDeclaration.clientId);
    expect(currentDecision(entries, a.clientId, "member")?.values).toMatchObject({
      decision: "declined",
    });
    expect(currentDecision(entries, next.clientId, "member")?.values).toMatchObject({
      decision: "accepted",
    });
    expect(rows.filter((row) => row.values.kind === "agreement")).toHaveLength(2);
    await expect(
      owner.mutation(api.projectWork.appendCredit, {
        actorId: "owner",
        clientId: a.clientId,
        projectClientId,
        idempotencyKey: "overwrite",
        values: agreement,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const other = await append("other", declaration());
    await expect(
      append("other", {
        ...decision,
        agreementClientId: next.clientId,
        declarationClientId: other.clientId,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});
