import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { defaultCohortCriteria } from "@/src/lib/cohort-analysis";

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/analyses.ts": () => import("@/convex/analyses"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "University",
    kind: "university",
    country: "RU",
    city: "",
    description: "",
    published: false,
  });
  for (const [userId, role] of [
    ["researcher", "researcher"],
    ["doctor", "doctor"],
    ["admin", "admin"],
  ] as const)
    await t.mutation(internal.provisioning.approveMembership, { userId, role, organizationId });
  const researcher = t.withIdentity({ subject: "researcher" });
  const args = {
    actorId: "researcher",
    organizationId,
    clientId: crypto.randomUUID(),
    expectedRevision: 0,
    action: "create" as const,
    values: {
      title: "Private analysis title",
      description: "Private analysis description",
      criteria: { ...defaultCohortCriteria, include: ["F41"] },
    },
    idempotencyKey: "create",
  };
  return { t, researcher, organizationId, args };
}
describe("owned saved analysis definitions", () => {
  it("lets researchers edit their own criteria with CAS and idempotency, without editing patients", async () => {
    const { t, researcher, args } = await setup();
    expect(await researcher.mutation(api.analyses.apply, args)).toEqual({ revision: 1 });
    expect(await researcher.mutation(api.analyses.apply, args)).toEqual({ revision: 1 });
    const update = {
      ...args,
      action: "update" as const,
      expectedRevision: 1,
      values: { ...args.values, title: "Revised title" },
      idempotencyKey: "update",
    };
    await researcher.mutation(api.analyses.apply, update);
    await expect(
      researcher.mutation(api.analyses.apply, { ...update, idempotencyKey: "stale" }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const rows = await researcher.query(api.analyses.list, {
      actorId: args.actorId,
      organizationId: args.organizationId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: 2, values: { title: "Revised title" } });
    expect(rows[0]).not.toHaveProperty("userId");
    expect(await t.run((ctx) => ctx.db.query("patients").collect())).toEqual([]);
    const audit = await t.run((ctx) => ctx.db.query("analysisAudit").collect());
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/Private|Revised|F41/);
    const { values: _values, ...remove } = args;
    const deletion = {
      ...remove,
      action: "delete" as const,
      expectedRevision: 2,
      idempotencyKey: "delete",
    };
    await researcher.mutation(api.analyses.apply, deletion);
    expect(await researcher.mutation(api.analyses.apply, deletion)).toEqual({ revision: 3 });
    expect(
      (
        await researcher.query(api.analyses.list, {
          actorId: args.actorId,
          organizationId: args.organizationId,
        })
      )[0],
    ).toMatchObject({ revision: 3, deleted: true, values: null });
    await expect(
      researcher.mutation(api.analyses.apply, { ...args, idempotencyKey: "resurrect" }),
    ).rejects.toThrow("REVISION_CONFLICT");
  });
  it("isolates owners and organizations and rejects anonymous, administrator and changed actors", async () => {
    const { t, researcher, args, organizationId } = await setup();
    await researcher.mutation(api.analyses.apply, args);
    await expect(t.mutation(api.analyses.apply, args)).rejects.toThrow("UNAUTHENTICATED");
    for (const userId of ["admin", "outsider"]) {
      await expect(
        t
          .withIdentity({ subject: userId })
          .query(api.analyses.list, { actorId: userId, organizationId }),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    const doctor = t.withIdentity({ subject: "doctor" });
    expect(await doctor.query(api.analyses.list, { actorId: "doctor", organizationId })).toEqual(
      [],
    );
    await expect(
      doctor.mutation(api.analyses.apply, {
        ...args,
        actorId: "doctor",
        action: "update",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await doctor.mutation(api.analyses.apply, {
      ...args,
      actorId: "doctor",
      clientId: crypto.randomUUID(),
    });
    expect(
      await doctor.query(api.analyses.list, { actorId: "doctor", organizationId }),
    ).toHaveLength(1);
    expect(
      await researcher.query(api.analyses.list, { actorId: "researcher", organizationId }),
    ).toHaveLength(1);
    await expect(
      researcher.mutation(api.analyses.apply, { ...args, actorId: "doctor" }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    const other = await t.mutation(internal.provisioning.createOrganization, {
      name: "Other",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    await expect(
      researcher.mutation(api.analyses.apply, { ...args, organizationId: other }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
  it("validates definitions, rejects key reuse and rechecks revoked membership before returning receipts", async () => {
    const { t, researcher, args, organizationId } = await setup();
    await expect(
      researcher.mutation(api.analyses.apply, { ...args, values: { ...args.values, title: " " } }),
    ).rejects.toThrow("INVALID_ANALYSIS");
    await expect(
      researcher.mutation(api.analyses.apply, { ...args, expectedRevision: 1.5 }),
    ).rejects.toThrow("INVALID_ANALYSIS");
    await researcher.mutation(api.analyses.apply, args);
    await expect(
      researcher.mutation(api.analyses.apply, {
        ...args,
        values: { ...args.values, title: "Changed" },
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_organization_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", "researcher"),
        )
        .unique();
      await ctx.db.patch(membership!._id, { active: false });
    });
    await expect(researcher.mutation(api.analyses.apply, args)).rejects.toThrow("ACCESS_DENIED");
  });
});
