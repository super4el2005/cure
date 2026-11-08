import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { ProjectValues } from "@/src/lib/research-model";

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/projects.ts": () => import("@/convex/projects"),
  "../convex/projectTeams.ts": () => import("@/convex/projectTeams"),
  "../convex/protocols.ts": () => import("@/convex/protocols"),
};
const projectId = "8df7de54-a59e-41fd-8a44-480b44a12f0c";
const values: ProjectValues = {
  title: "Collaborative study",
  summary: "Public study description",
  topic: "Public topic",
  kind: "prospective",
  status: "draft",
  published: false,
  publicEligibility: "Public eligibility",
  publicContact: "Public coordinator",
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
  for (const userId of ["owner", "member", "viewer"])
    await t.mutation(internal.provisioning.approveMembership, {
      userId,
      organizationId,
      role: "researcher",
    });
  const owner = t.withIdentity({ subject: "owner" });
  const args = {
    actorId: "owner",
    organizationId,
    clientId: projectId,
    idempotencyKey: "project.create",
    expectedRevision: 0,
    values,
  };
  return { t, owner, organizationId, args };
}
describe("research project and protocol invariants", () => {
  it("creates projects once and checks current identity and affiliation before a receipt", async () => {
    const { t, owner, organizationId, args } = await setup();
    await expect(t.mutation(api.projects.apply, args)).rejects.toThrow("UNAUTHENTICATED");
    await owner.mutation(api.projects.apply, args);
    expect(await owner.mutation(api.projects.apply, args)).toEqual({ revision: 1 });
    expect(await t.run((ctx) => ctx.db.query("projects").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("projectMembers").collect())).toHaveLength(1);
    await expect(
      t.withIdentity({ subject: "member" }).mutation(api.projects.apply, args),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", "owner"),
        )
        .unique();
      await ctx.db.patch(member!._id, { active: false });
    });
    await expect(owner.mutation(api.projects.apply, args)).rejects.toThrow("ACCESS_DENIED");
  });
  it("keeps private projects and protocol details out of public APIs", async () => {
    const { t, owner, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    expect(await t.query(api.projects.publicDetails, { clientId: projectId })).toBeNull();
    await expect(
      t
        .withIdentity({ subject: "member" })
        .query(api.projects.details, { clientId: projectId, actorId: "owner" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await owner.mutation(api.projects.apply, {
      ...args,
      expectedRevision: 1,
      idempotencyKey: "project.publish",
      values: { ...values, status: "preparing", published: true },
    });
    const publicData = await t.query(api.projects.publicDetails, { clientId: projectId });
    expect(publicData?.title).toBe(values.title);
    expect(publicData).not.toHaveProperty("createdBy");
    const page = await t.query(api.projects.publicPage, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(page.page).toHaveLength(1);
    expect(page.isDone).toBe(true);
    expect(page.page[0]).not.toHaveProperty("organizationId");
  });
  it("requires a protocol and current ethics approval for recruitment, then pauses on amendment", async () => {
    const { t, owner, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    await owner.mutation(api.projects.apply, {
      ...args,
      expectedRevision: 1,
      idempotencyKey: "prepare",
      values: { ...values, status: "preparing" },
    });
    await expect(
      owner.mutation(api.projects.apply, {
        ...args,
        expectedRevision: 2,
        idempotencyKey: "recruit",
        values: { ...values, status: "recruiting", published: true },
      }),
    ).rejects.toThrow("ETHICS_APPROVAL_REQUIRED");
    const protocol = {
      actorId: "owner",
      projectClientId: projectId,
      clientId: crypto.randomUUID(),
      expectedVersion: 0,
      idempotencyKey: "protocol.1",
      values: {
        hypothesis: "Private hypothesis",
        inclusion: "Private criteria",
        exclusion: "",
        endpoints: "Private outcomes",
        analysisPlan: "Private analysis plan",
        ethicsApproved: true,
        ethicsReference: "Committee document",
        ethicsExpiresAt: Date.now() + 60000,
      },
    };
    await owner.mutation(api.protocols.append, protocol);
    await owner.mutation(api.protocols.append, protocol);
    expect(
      await owner.query(api.protocols.history, { projectClientId: projectId, actorId: "owner" }),
    ).toHaveLength(1);
    await owner.mutation(api.projects.apply, {
      ...args,
      expectedRevision: 2,
      idempotencyKey: "recruit",
      values: { ...values, status: "recruiting", published: true },
    });
    await owner.mutation(api.protocols.append, {
      ...protocol,
      clientId: crypto.randomUUID(),
      expectedVersion: 1,
      idempotencyKey: "protocol.2",
      values: { ...protocol.values, hypothesis: "New private hypothesis" },
    });
    const project = await owner.query(api.projects.details, {
      clientId: projectId,
      actorId: "owner",
    });
    expect(project.status).toBe("preparing");
    expect(project.revision).toBe(4);
    expect(
      await owner.query(api.protocols.mine, {
        organizationId: args.organizationId,
        actorId: "owner",
      }),
    ).toHaveLength(2);
    expect(
      await t
        .withIdentity({ subject: "member" })
        .query(api.protocols.mine, { organizationId: args.organizationId, actorId: "member" }),
    ).toEqual([]);

    expect(
      JSON.stringify(await t.query(api.projects.publicDetails, { clientId: projectId })),
    ).not.toContain("Private");
    await expect(
      owner.mutation(api.protocols.append, {
        ...protocol,
        clientId: crypto.randomUUID(),
        idempotencyKey: "protocol.stale",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
  });
  it("does not let viewers edit projects or append protocols", async () => {
    const { t, owner, organizationId, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    await t.run((ctx) =>
      ctx.db.insert("projectMembers", {
        clientId: "viewer-member",
        projectClientId: projectId,
        userId: "viewer",
        organizationId,
        role: "viewer",
        active: true,
        revision: 1,
      }),
    );
    const viewer = t.withIdentity({ subject: "viewer" });
    expect(
      (await viewer.query(api.projects.details, { clientId: projectId, actorId: "viewer" }))
        .selfRole,
    ).toBe("viewer");
    await expect(
      viewer.mutation(api.projects.apply, {
        ...args,
        actorId: "viewer",
        expectedRevision: 1,
        idempotencyKey: "viewer-edit",
        values: { ...values, title: "Changed" },
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      viewer.mutation(api.protocols.append, {
        actorId: "viewer",
        projectClientId: projectId,
        clientId: crypto.randomUUID(),
        expectedVersion: 0,
        idempotencyKey: "viewer-protocol",
        values: {
          hypothesis: "x",
          inclusion: "",
          exclusion: "",
          endpoints: "x",
          analysisPlan: "x",
          ethicsApproved: false,
          ethicsReference: "",
          ethicsExpiresAt: 0,
        },
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});

describe("research collaboration invitations", () => {
  it("requires the invited account and affiliation, preserves the granted role, and replays once", async () => {
    const { t, owner, organizationId, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    const profileId = await t.run((ctx) =>
      ctx.db.insert("profiles", {
        userId: "member",
        displayName: "Invited researcher",
        profession: "researcher",
        specialty: "",
        interests: [],
        languages: [],
        bio: "",
        published: true,
        verified: true,
        updatedAt: Date.now(),
      }),
    );
    const clientId = crypto.randomUUID();
    const invitation = {
      actorId: "owner",
      projectClientId: projectId,
      clientId,
      targetProfileId: profileId,
      role: "member" as const,
      idempotencyKey: "invite",
    };
    await owner.mutation(api.projectTeams.invite, invitation);
    await owner.mutation(api.projectTeams.invite, invitation);
    const member = t.withIdentity({ subject: "member" });
    const response = {
      actorId: "member",
      clientId,
      organizationId,
      decision: "accept" as const,
      expectedRevision: 1,
      idempotencyKey: "accept",
    };
    await expect(
      t.withIdentity({ subject: "viewer" }).mutation(api.projectTeams.respond, response),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      member.mutation(api.projectTeams.respond, {
        actorId: response.actorId,
        clientId,
        decision: "accept",
        expectedRevision: 1,
        idempotencyKey: "missing-affiliation",
      }),
    ).rejects.toThrow("AFFILIATION_REQUIRED");
    await member.mutation(api.projectTeams.respond, response);
    await member.mutation(api.projectTeams.respond, response);
    const members = await owner.query(api.projectTeams.members, {
      projectClientId: projectId,
      actorId: "owner",
    });
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === "member")?.role).toBe("member");
    await expect(
      member.mutation(api.projects.apply, {
        ...args,
        actorId: "member",
        expectedRevision: 1,
        idempotencyKey: "member-edit",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await owner.mutation(api.projectTeams.setMember, {
      actorId: "owner",
      projectClientId: projectId,
      targetUserId: "member",
      role: "member",
      active: false,
      expectedRevision: 1,
      idempotencyKey: "remove",
    });
    await expect(
      member.query(api.projects.details, { clientId: projectId, actorId: "member" }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      owner.mutation(api.projectTeams.setMember, {
        actorId: "owner",
        projectClientId: projectId,
        targetUserId: "member",
        role: "member",
        active: true,
        expectedRevision: 2,
        idempotencyKey: "reactivate",
      }),
    ).rejects.toThrow("NEW_INVITATION_REQUIRED");
  });
  it("does not leak private subscriptions across an account change", async () => {
    const { t, owner, args, organizationId } = await setup();
    await owner.mutation(api.projects.apply, args);
    await expect(
      owner.query(api.projects.mine, { organizationId, actorId: "member" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      owner.query(api.projectTeams.members, { projectClientId: projectId, actorId: "member" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(owner.query(api.projectTeams.invitations, { actorId: "member" })).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    await expect(
      owner.query(api.protocols.history, { projectClientId: projectId, actorId: "member" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(await t.query(api.projects.publicDetails, { clientId: projectId })).toBeNull();
  });
});

describe("team workspace projections", () => {
  it("shows incoming decisions without granting project access and hides others' invitations from members", async () => {
    const { t, owner, organizationId, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    const profiles = await t.run(async (ctx) => {
      const result = [];
      for (const userId of ["member", "viewer"])
        result.push(
          await ctx.db.insert("profiles", {
            userId,
            displayName: userId,
            profession: "researcher",
            specialty: "",
            interests: [],
            languages: [],
            bio: "",
            published: true,
            verified: true,
            updatedAt: Date.now(),
          }),
        );
      return result;
    });
    const first = crypto.randomUUID();
    await owner.mutation(api.projectTeams.invite, {
      actorId: "owner",
      projectClientId: projectId,
      clientId: first,
      targetProfileId: profiles[0]!,
      role: "member",
      idempotencyKey: "invite.member",
    });
    const member = t.withIdentity({ subject: "member" });
    const viewer = t.withIdentity({ subject: "viewer" });
    const before = await member.query(api.projectTeams.workspace, {
      actorId: "member",
      organizationId,
    });
    expect(before).toHaveLength(1);
    expect(before[0]?.entity).toBe("invitation");
    expect(await member.query(api.projects.mine, { actorId: "member", organizationId })).toEqual(
      [],
    );
    await member.mutation(api.projectTeams.respond, {
      actorId: "member",
      clientId: first,
      organizationId,
      decision: "accept",
      expectedRevision: 1,
      idempotencyKey: "join.member",
    });
    const second = crypto.randomUUID();
    await owner.mutation(api.projectTeams.invite, {
      actorId: "owner",
      projectClientId: projectId,
      clientId: second,
      targetProfileId: profiles[1]!,
      role: "coordinator",
      idempotencyKey: "invite.coordinator",
    });
    const memberState = await member.query(api.projectTeams.workspace, {
      actorId: "member",
      organizationId,
    });
    expect(memberState.filter((row) => row.entity === "member")).toHaveLength(2);
    expect(memberState.filter((row) => row.entity === "invitation")).toHaveLength(1);
    expect(memberState.some((row) => row.clientId === second)).toBe(false);
    const incoming = await viewer.query(api.projectTeams.workspace, {
      actorId: "viewer",
      organizationId,
    });
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.clientId).toBe(second);
    await expect(
      viewer.query(api.projectTeams.workspace, { actorId: "member", organizationId }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await viewer.mutation(api.projectTeams.respond, {
      actorId: "viewer",
      clientId: second,
      organizationId,
      decision: "accept",
      expectedRevision: 1,
      idempotencyKey: "join.coordinator",
    });
    await expect(
      viewer.mutation(api.projectTeams.setMember, {
        actorId: "viewer",
        projectClientId: projectId,
        targetUserId: "owner",
        role: "viewer",
        active: false,
        expectedRevision: 1,
        idempotencyKey: "remove.owner",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      viewer.mutation(api.projectTeams.invite, {
        actorId: "viewer",
        projectClientId: projectId,
        clientId: crypto.randomUUID(),
        targetProfileId: profiles[0]!,
        role: "coordinator",
        idempotencyKey: "promote.other",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
  it("replays a decline exactly once and does not permit acceptance after expiry or revocation", async () => {
    const { t, owner, organizationId, args } = await setup();
    await owner.mutation(api.projects.apply, args);
    const profileId = await t.run((ctx) =>
      ctx.db.insert("profiles", {
        userId: "member",
        displayName: "Member",
        profession: "researcher",
        specialty: "",
        interests: [],
        languages: [],
        bio: "",
        published: true,
        verified: true,
        updatedAt: Date.now(),
      }),
    );
    const member = t.withIdentity({ subject: "member" });
    const invite = async () => {
      const clientId = crypto.randomUUID();
      await owner.mutation(api.projectTeams.invite, {
        actorId: "owner",
        projectClientId: projectId,
        clientId,
        targetProfileId: profileId,
        role: "member",
        idempotencyKey: clientId,
      });
      return clientId;
    };
    const first = await invite();
    const decline = {
      actorId: "member",
      clientId: first,
      decision: "decline" as const,
      expectedRevision: 1,
      idempotencyKey: "decline",
    };
    await member.mutation(api.projectTeams.respond, decline);
    expect(await member.mutation(api.projectTeams.respond, decline)).toEqual({ revision: 2 });
    expect(await t.run((ctx) => ctx.db.query("projectMembers").collect())).toHaveLength(1);
    const expired = await invite();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("collaborationInvites")
        .withIndex("by_client", (q) => q.eq("clientId", expired))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      member.mutation(api.projectTeams.respond, {
        ...decline,
        clientId: expired,
        organizationId,
        decision: "accept",
        idempotencyKey: "expired",
      }),
    ).rejects.toThrow("INVITE_EXPIRED");
    const revoked = await invite();
    const revocation = {
      actorId: "owner",
      clientId: revoked,
      expectedRevision: 1,
      idempotencyKey: "revoke",
    };
    await owner.mutation(api.projectTeams.revokeInvite, revocation);
    expect(await owner.mutation(api.projectTeams.revokeInvite, revocation)).toEqual({
      revision: 2,
    });
    await expect(
      member.mutation(api.projectTeams.respond, {
        ...decline,
        clientId: revoked,
        organizationId,
        decision: "accept",
        expectedRevision: 2,
        idempotencyKey: "revoked",
      }),
    ).rejects.toThrow("INVITE_NOT_PENDING");
  });
});
