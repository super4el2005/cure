import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import type { TaskValues } from "@/src/lib/project-work-model";
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
describe("project task permissions and revisions", () => {
  it("permits the assignee to update a task without permitting reassignment or unrelated edits", async () => {
    const { t, owner, member, organizationId, projectClientId, values } = await setup();
    const clientId = crypto.randomUUID();
    const create = {
      actorId: "owner",
      clientId,
      projectClientId,
      expectedRevision: 0,
      idempotencyKey: "task",
      values,
    };
    await owner.mutation(api.projectWork.saveTask, create);
    expect(await owner.mutation(api.projectWork.saveTask, create)).toEqual({ revision: 1 });
    await expect(
      t.withIdentity({ subject: "other" }).mutation(api.projectWork.saveTask, {
        ...create,
        actorId: "other",
        expectedRevision: 1,
        idempotencyKey: "unrelated",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      member.mutation(api.projectWork.saveTask, {
        ...create,
        actorId: "member",
        expectedRevision: 1,
        idempotencyKey: "reassign",
        values: { ...values, assigneeId: "owner" },
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    const complete = {
      ...create,
      actorId: "member",
      expectedRevision: 1,
      idempotencyKey: "complete",
      values: { ...values, status: "done" as const },
    };
    await member.mutation(api.projectWork.saveTask, complete);
    expect(await member.mutation(api.projectWork.saveTask, complete)).toEqual({ revision: 2 });
    await expect(
      owner.mutation(api.projectWork.saveTask, {
        ...create,
        expectedRevision: 1,
        idempotencyKey: "stale",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await owner.mutation(api.projectWork.saveTask, {
      ...create,
      expectedRevision: 2,
      idempotencyKey: "archive",
      values: { ...values, status: "done", archived: true },
    });
    expect(
      (await member.query(api.projectWork.workspace, { organizationId, actorId: "member" }))[0],
    ).toMatchObject({ entity: "task", status: "done", archived: true, revision: 3 });
    const audit = await t.run((ctx) => ctx.db.query("researchAudit").collect());
    expect(JSON.stringify(audit)).not.toContain(values.title);
    expect(JSON.stringify(audit)).not.toContain(values.description);
  });
  it("validates assignee eligibility and rejects writes from viewers, other accounts and archived projects", async () => {
    const { t, owner, member, organizationId, projectClientId, projectValues, values } =
      await setup();
    const create = {
      actorId: "owner",
      clientId: crypto.randomUUID(),
      projectClientId,
      expectedRevision: 0,
      idempotencyKey: "task",
      values,
    };
    await expect(
      owner.mutation(api.projectWork.saveTask, {
        ...create,
        values: { ...values, assigneeId: "viewer" },
      }),
    ).rejects.toThrow("ASSIGNEE_UNAVAILABLE");
    await expect(member.mutation(api.projectWork.saveTask, create)).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    await expect(
      t
        .withIdentity({ subject: "viewer" })
        .mutation(api.projectWork.saveTask, { ...create, actorId: "viewer" }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(
      await t
        .withIdentity({ subject: "outsider" })
        .query(api.projectWork.workspace, { organizationId, actorId: "outsider" }),
    ).toEqual([]);
    await expect(
      owner.query(api.projectWork.workspace, { organizationId, actorId: "member" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await owner.mutation(api.projects.apply, {
      actorId: "owner",
      clientId: projectClientId,
      organizationId,
      expectedRevision: 1,
      idempotencyKey: "archive-project",
      values: { ...projectValues, status: "archived" },
    });
    await expect(owner.mutation(api.projectWork.saveTask, create)).rejects.toThrow(
      "PROJECT_ARCHIVED",
    );
  });
});
describe("research discussion authorship", () => {
  it("preserves authorship, handles edits by revision and redacts deleted messages", async () => {
    const { t, owner, member, organizationId, projectClientId } = await setup();
    const clientId = crypto.randomUUID();
    const create = {
      actorId: "member",
      clientId,
      projectClientId,
      expectedRevision: 0,
      idempotencyKey: "message",
      action: "create" as const,
      body: "Private discussion",
    };
    await member.mutation(api.projectWork.saveMessage, create);
    expect(await member.mutation(api.projectWork.saveMessage, create)).toEqual({ revision: 1 });
    await expect(
      owner.mutation(api.projectWork.saveMessage, {
        ...create,
        actorId: "owner",
        expectedRevision: 1,
        action: "update",
        idempotencyKey: "impersonate",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await member.mutation(api.projectWork.saveMessage, {
      ...create,
      expectedRevision: 1,
      action: "update",
      idempotencyKey: "edit",
      body: "Revised discussion",
    });
    await expect(
      member.mutation(api.projectWork.saveMessage, {
        ...create,
        expectedRevision: 1,
        action: "update",
        idempotencyKey: "stale",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const remove = {
      ...create,
      actorId: "owner",
      expectedRevision: 2,
      action: "delete" as const,
      body: "",
      idempotencyKey: "moderate",
    };
    await owner.mutation(api.projectWork.saveMessage, remove);
    expect(await owner.mutation(api.projectWork.saveMessage, remove)).toEqual({ revision: 3 });
    const rows = await member.query(api.projectWork.workspace, {
      organizationId,
      actorId: "member",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      createdBy: "member",
      entity: "message",
      body: "",
      deleted: true,
      revision: 3,
    });
    expect(rows[0]).not.toHaveProperty("_id");
    await expect(
      member.mutation(api.projectWork.saveMessage, {
        ...create,
        expectedRevision: 3,
        action: "update",
        idempotencyKey: "restore",
      }),
    ).rejects.toThrow("MESSAGE_DELETED");
    await expect(
      t.withIdentity({ subject: "viewer" }).mutation(api.projectWork.saveMessage, {
        ...create,
        actorId: "viewer",
        clientId: crypto.randomUUID(),
        idempotencyKey: "viewer-post",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});
