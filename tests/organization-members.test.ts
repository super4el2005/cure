import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { workspaceAdmission } from "@/src/lib/workspace-admission";

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/organizationMembers.ts": () => import("@/convex/organizationMembers"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
  "../convex/profiles.ts": () => import("@/convex/profiles"),
  "../convex/patients.ts": () => import("@/convex/patients"),
};
const page = { numItems: 25, cursor: null };
async function setup() {
  const t = convexTest(schema, modules);
  const organizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "Clinic",
    kind: "clinic",
    country: "RU",
    city: "",
    description: "",
    published: true,
  });
  const otherOrganizationId = await t.mutation(internal.provisioning.createOrganization, {
    name: "Other clinic",
    kind: "clinic",
    country: "RU",
    city: "",
    description: "",
    published: true,
  });
  const adminId = await t.mutation(internal.provisioning.approveMembership, {
    organizationId,
    userId: "admin",
    role: "admin",
  });
  const backupId = await t.mutation(internal.provisioning.approveMembership, {
    organizationId,
    userId: "backup",
    role: "admin",
  });
  await t.mutation(internal.provisioning.approveMembership, {
    organizationId: otherOrganizationId,
    userId: "outside-admin",
    role: "admin",
  });
  for (const [userId, profession] of [
    ["doctor", "doctor"],
    ["researcher", "researcher"],
    ["backup", "doctor"],
    ["unverified", "doctor"],
  ] as const) {
    await t.withIdentity({ subject: userId }).mutation(api.profiles.save, {
      actorId: userId,
      displayName: `Private ${userId}`,
      profession,
      specialty: "",
      interests: [],
      languages: [],
      bio: "",
      published: false,
    });
    if (userId !== "unverified")
      await t.mutation(internal.provisioning.verifyProfile, { userId, verified: true });
  }
  const admin = t.withIdentity({ subject: "admin" });
  const doctor = t.withIdentity({ subject: "doctor" });
  const researcher = t.withIdentity({ subject: "researcher" });
  const requestArgs = {
    actorId: "doctor",
    organizationId,
    expectedRevision: 0,
    role: "doctor" as const,
    message: "Private membership rationale",
    idempotencyKey: "request",
  };
  const pending = async () =>
    (
      await admin.query(api.organizationMembers.pending, {
        actorId: "admin",
        organizationId,
        paginationOpts: page,
      })
    ).page;
  const requestDoctor = async () => {
    await doctor.mutation(api.organizationMembers.request, requestArgs);
    return (await pending())[0]!;
  };
  return {
    t,
    organizationId,
    otherOrganizationId,
    adminId,
    backupId,
    admin,
    doctor,
    researcher,
    requestArgs,
    pending,
    requestDoctor,
  };
}
describe("organization membership administration", () => {
  it("keeps requests separate from rights, deduplicates delivery and limits applicant reads", async () => {
    const { t, admin, doctor, researcher, requestArgs, organizationId } = await setup();
    expect(await doctor.mutation(api.organizationMembers.request, requestArgs)).toEqual({
      revision: 1,
    });
    expect(await doctor.mutation(api.organizationMembers.request, requestArgs)).toEqual({
      revision: 1,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_user", (q) => q.eq("userId", "doctor"))
          .collect(),
      ),
    ).toEqual([]);
    await expect(
      doctor.mutation(api.organizationMembers.request, {
        ...requestArgs,
        expectedRevision: 1,
        idempotencyKey: "already-pending",
      }),
    ).rejects.toThrow("MEMBERSHIP_REQUEST_PENDING");
    const mine = await doctor.query(api.organizationMembers.mine, {
      actorId: "doctor",
      paginationOpts: page,
    });
    expect(mine.page).toHaveLength(1);
    expect(mine.page[0]?.status).toBe("pending");
    expect(
      (
        await researcher.query(api.organizationMembers.mine, {
          actorId: "researcher",
          paginationOpts: page,
        })
      ).page,
    ).toEqual([]);
    await expect(
      doctor.query(api.organizationMembers.mine, { actorId: "researcher", paginationOpts: page }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    await expect(
      doctor.mutation(api.organizationMembers.request, {
        ...requestArgs,
        idempotencyKey: "duplicate",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    const events = await admin.query(api.organizationMembers.audit, {
      actorId: "admin",
      organizationId,
      paginationOpts: page,
    });
    expect(events.page).toHaveLength(1);
  });
  it("requires independently verified matching professions and published organizations", async () => {
    const { t, doctor, researcher, requestArgs, organizationId } = await setup();
    await expect(
      t
        .withIdentity({ subject: "unverified" })
        .mutation(api.organizationMembers.request, { ...requestArgs, actorId: "unverified" }),
    ).rejects.toThrow("PROFESSIONAL_VERIFICATION_REQUIRED");
    await expect(
      researcher.mutation(api.organizationMembers.request, {
        ...requestArgs,
        actorId: "researcher",
      }),
    ).rejects.toThrow("PROFESSIONAL_VERIFICATION_REQUIRED");
    await t.run((ctx) => ctx.db.patch(organizationId, { published: false }));
    await expect(doctor.mutation(api.organizationMembers.request, requestArgs)).rejects.toThrow(
      "ORGANIZATION_UNAVAILABLE",
    );
  });
  it("denies unauthorized member, pending and audit queries including cross-organization administrators", async () => {
    const { t, doctor, organizationId, admin, otherOrganizationId } = await setup();
    for (const query of [
      api.organizationMembers.members,
      api.organizationMembers.pending,
      api.organizationMembers.audit,
    ]) {
      await expect(
        t.query(query, { actorId: "none", organizationId, paginationOpts: page }),
      ).rejects.toThrow("UNAUTHENTICATED");
      await expect(
        doctor.query(query, { actorId: "doctor", organizationId, paginationOpts: page }),
      ).rejects.toThrow("ACCESS_DENIED");
      await expect(
        admin.query(query, {
          actorId: "admin",
          organizationId: otherOrganizationId,
          paginationOpts: page,
        }),
      ).rejects.toThrow("ACCESS_DENIED");
    }
  });
  it("grants doctor CRUD only after review and never gives admins medical access", async () => {
    const { t, admin, doctor, organizationId, requestDoctor } = await setup();
    const request = await requestDoctor();
    const args = {
      actorId: "admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "Private decision rationale",
      idempotencyKey: "approve",
    };
    expect(await admin.mutation(api.organizationMembers.review, args)).toEqual({ revision: 2 });
    expect(await admin.mutation(api.organizationMembers.review, args)).toEqual({ revision: 2 });
    const patient = {
      actorId: "doctor",
      organizationId,
      clientId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "create" as const,
      idempotencyKey: "patient",
      values: {
        fullName: "Clinical secret",
        birthDate: "1990-01-01",
        sex: "unknown" as const,
        diagnosisCodes: [],
        notes: "Private clinical note",
      },
    };
    expect(await doctor.mutation(api.patients.apply, patient)).toEqual({ revision: 1 });
    await expect(
      admin.mutation(api.patients.apply, { ...patient, actorId: "admin" }),
    ).rejects.toThrow("ACCESS_DENIED");
    const metadata = await t.run((ctx) => ctx.db.query("membershipAudit").collect());
    expect(JSON.stringify(metadata)).not.toMatch(/Private|Clinical secret|1990/);
    expect(
      (
        await admin.query(api.organizationMembers.audit, {
          actorId: "admin",
          organizationId,
          paginationOpts: page,
        })
      ).page[0]?.reason,
    ).toBe(args.reason);
    expect(await t.run((ctx) => ctx.db.query("membershipDecisionNotes").collect())).toHaveLength(1);
  });
  it("keeps researcher membership read-only for patients", async () => {
    const { admin, researcher, organizationId, requestArgs, pending } = await setup();
    await researcher.mutation(api.organizationMembers.request, {
      ...requestArgs,
      actorId: "researcher",
      role: "researcher",
    });
    const request = (await pending())[0]!;
    await admin.mutation(api.organizationMembers.review, {
      actorId: "admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "Checked",
      idempotencyKey: "approve-researcher",
    });
    expect(
      await researcher.query(api.patients.list, { actorId: "researcher", organizationId }),
    ).toEqual([]);
    await expect(
      researcher.mutation(api.patients.apply, {
        actorId: "researcher",
        organizationId,
        clientId: crypto.randomUUID(),
        expectedRevision: 0,
        action: "create",
        idempotencyKey: "forbidden",
        values: { fullName: "No", birthDate: "", sex: "unknown", diagnosisCodes: [], notes: "" },
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
  it("rejects stale reviews and checks qualifications again at approval time", async () => {
    const { t, admin, requestDoctor } = await setup();
    const request = await requestDoctor();
    const args = {
      actorId: "admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "Checked",
      idempotencyKey: "approve",
    };
    await expect(
      admin.mutation(api.organizationMembers.review, { ...args, expectedRevision: 0 }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await t.mutation(internal.provisioning.verifyProfile, { userId: "doctor", verified: false });
    await expect(admin.mutation(api.organizationMembers.review, args)).rejects.toThrow(
      "PROFESSIONAL_VERIFICATION_REQUIRED",
    );
    await admin.mutation(api.organizationMembers.review, { ...args, approved: false });
  });
  it("does not overwrite membership changes made after the request", async () => {
    const { t, admin, organizationId, requestDoctor } = await setup();
    const request = await requestDoctor();
    await t.mutation(internal.provisioning.approveMembership, {
      organizationId,
      userId: "doctor",
      role: "doctor",
    });
    await expect(
      admin.mutation(api.organizationMembers.review, {
        actorId: "admin",
        requestId: request._id,
        expectedRevision: 1,
        approved: true,
        reason: "Checked",
        idempotencyKey: "approve",
      }),
    ).rejects.toThrow("MEMBERSHIP_CHANGED");
  });
  it("supports withdrawal and a new reviewed request, with conflict detection", async () => {
    const { admin, doctor, requestArgs, requestDoctor } = await setup();
    const request = await requestDoctor();
    const withdrawal = {
      actorId: "doctor",
      requestId: request._id,
      expectedRevision: 1,
      idempotencyKey: "withdraw",
    };
    expect(await doctor.mutation(api.organizationMembers.withdraw, withdrawal)).toEqual({
      revision: 2,
    });
    expect(await doctor.mutation(api.organizationMembers.withdraw, withdrawal)).toEqual({
      revision: 2,
    });
    await expect(
      admin.mutation(api.organizationMembers.review, {
        actorId: "admin",
        requestId: request._id,
        expectedRevision: 1,
        approved: true,
        reason: "Checked",
        idempotencyKey: "stale",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(
      await doctor.mutation(api.organizationMembers.request, {
        ...requestArgs,
        expectedRevision: 2,
        idempotencyKey: "again",
      }),
    ).toEqual({ revision: 3 });
    await expect(
      doctor.mutation(api.organizationMembers.withdraw, {
        ...withdrawal,
        idempotencyKey: "stale-withdraw",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
  });
  it("uses membership CAS, independent role verification and idempotent suspension", async () => {
    const { t, admin, doctor, organizationId, requestDoctor } = await setup();
    const request = await requestDoctor();
    await admin.mutation(api.organizationMembers.review, {
      actorId: "admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "Checked",
      idempotencyKey: "approve",
    });
    const membership = (
      await admin.query(api.organizationMembers.members, {
        actorId: "admin",
        organizationId,
        paginationOpts: page,
      })
    ).page.find((row) => row.userId === "doctor")!;
    const args = {
      actorId: "admin",
      membershipId: membership.id,
      expectedRevision: membership.revision,
      role: "doctor" as const,
      active: false,
      reason: "Private suspension reason",
      idempotencyKey: "suspend",
    };
    expect(await admin.mutation(api.organizationMembers.change, args)).toEqual({ revision: 2 });
    expect(await admin.mutation(api.organizationMembers.change, args)).toEqual({ revision: 2 });
    await expect(
      doctor.query(api.patients.list, { actorId: "doctor", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      admin.mutation(api.organizationMembers.change, {
        ...args,
        active: true,
        idempotencyKey: "old",
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      admin.mutation(api.organizationMembers.change, {
        ...args,
        active: true,
        role: "researcher",
        expectedRevision: 2,
        idempotencyKey: "wrong-role",
      }),
    ).rejects.toThrow("PROFESSIONAL_VERIFICATION_REQUIRED");
    await admin.mutation(api.organizationMembers.change, {
      ...args,
      active: true,
      expectedRevision: 2,
      idempotencyKey: "restore",
    });
    expect(await doctor.query(api.patients.list, { actorId: "doctor", organizationId })).toEqual(
      [],
    );
    expect(
      JSON.stringify(await t.run((ctx) => ctx.db.query("membershipAudit").collect())),
    ).not.toContain("Private suspension reason");
  });
  it("checks administrator revocation before returning an old receipt", async () => {
    const { t, admin, adminId, backupId, organizationId } = await setup();
    const args = {
      actorId: "admin",
      membershipId: backupId,
      expectedRevision: 1,
      role: "admin" as const,
      active: true,
      reason: "Checked",
      idempotencyKey: "old-success",
    };
    await admin.mutation(api.organizationMembers.change, args);
    await t.withIdentity({ subject: "backup" }).mutation(api.organizationMembers.change, {
      actorId: "backup",
      membershipId: adminId,
      expectedRevision: 1,
      role: "admin",
      active: false,
      reason: "Revoked",
      idempotencyKey: "revoke-admin",
    });
    await expect(admin.mutation(api.organizationMembers.change, args)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(
      admin.query(api.organizationMembers.audit, {
        actorId: "admin",
        organizationId,
        paginationOpts: page,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      admin.mutation(api.organizationMembers.change, {
        ...args,
        expectedRevision: 2,
        active: false,
        idempotencyKey: "revoke-backup",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    const activeAdmins = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_organization_role_active", (q) =>
          q.eq("organizationId", organizationId).eq("role", "admin").eq("active", true),
        )
        .collect(),
    );
    expect(activeAdmins).toHaveLength(1);
  });
  it("rejects self-administration and actor spoofing", async () => {
    const { admin, adminId, backupId } = await setup();
    const args = {
      actorId: "admin",
      membershipId: adminId,
      expectedRevision: 1,
      role: "admin" as const,
      active: false,
      reason: "No",
      idempotencyKey: "self",
    };
    await expect(admin.mutation(api.organizationMembers.change, args)).rejects.toThrow(
      "SELF_MEMBERSHIP_CHANGE_DENIED",
    );
    await expect(
      admin.mutation(api.organizationMembers.change, {
        ...args,
        membershipId: backupId,
        actorId: "backup",
      }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
  });
  it("bounds pages and validates payloads and reused keys atomically", async () => {
    const { t, admin, doctor, requestArgs, organizationId, requestDoctor } = await setup();
    const request = await requestDoctor();
    await expect(
      doctor.mutation(api.organizationMembers.request, {
        ...requestArgs,
        message: "Other",
        idempotencyKey: "request",
      }),
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(
      admin.mutation(api.organizationMembers.review, {
        actorId: "admin",
        requestId: request._id,
        expectedRevision: 1,
        approved: true,
        reason: " ",
        idempotencyKey: "invalid",
      }),
    ).rejects.toThrow("INVALID_MEMBERSHIP");
    await expect(
      admin.query(api.organizationMembers.members, {
        actorId: "admin",
        organizationId,
        paginationOpts: { numItems: 51, cursor: null },
      }),
    ).rejects.toThrow("INVALID_REQUEST");
    expect(await t.run((ctx) => ctx.db.query("membershipDecisionNotes").collect())).toEqual([]);
  });
  it("paginates published organizations, searches by name and includes only the applicant's revision", async () => {
    const { t, doctor, requestArgs, organizationId } = await setup();
    await doctor.mutation(api.organizationMembers.request, requestArgs);
    const hidden = await t.mutation(internal.provisioning.createOrganization, {
      name: "Hidden clinic",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    const first = await doctor.query(api.organizationMembers.joinable, {
      actorId: "doctor",
      search: "",
      paginationOpts: { numItems: 1, cursor: null },
    });
    const second = await doctor.query(api.organizationMembers.joinable, {
      actorId: "doctor",
      search: "",
      paginationOpts: { numItems: 1, cursor: first.continueCursor },
    });
    expect(first.page).toHaveLength(1);
    expect(second.page).toHaveLength(1);
    expect(first.page[0]?.id).not.toBe(second.page[0]?.id);
    expect([...first.page, ...second.page].some((row) => row.id === hidden)).toBe(false);
    expect(
      [...first.page, ...second.page].find((row) => row.id === organizationId)?.requestRevision,
    ).toBe(1);
    const search = await doctor.query(api.organizationMembers.joinable, {
      actorId: "doctor",
      search: "Clinic",
      paginationOpts: page,
    });
    expect(search.page.some((row) => row.id === hidden)).toBe(false);
    expect(search.page.some((row) => row.id === organizationId)).toBe(true);
  });
  it("migrates revisionless memberships and closes the old clinical lease after a role change", async () => {
    const { t, admin, doctor, organizationId } = await setup();
    const id = await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: "doctor",
        organizationId,
        role: "doctor",
        active: true,
        verified: true,
      }),
    );
    const rows = await admin.query(api.organizationMembers.members, {
      actorId: "admin",
      organizationId,
      paginationOpts: page,
    });
    expect(rows.page.find((row) => row.id === id)?.revision).toBe(0);
    expect(
      await admin.mutation(api.organizationMembers.change, {
        actorId: "admin",
        membershipId: id,
        expectedRevision: 0,
        role: "admin",
        active: true,
        reason: "Administrative appointment",
        idempotencyKey: "promote",
      }),
    ).toEqual({ revision: 1 });
    await expect(
      doctor.query(api.patients.list, { actorId: "doctor", organizationId }),
    ).rejects.toThrow("ACCESS_DENIED");
    const profile = await doctor.query(api.profiles.mine, {});
    expect(
      workspaceAdmission(
        { userId: "doctor", organizationId, role: "doctor", expiresAt: 100 },
        {
          now: 50,
          localReady: true,
          localUserId: "doctor",
          sessionUserId: "doctor",
          isAuthenticated: true,
          online: true,
          profile,
        },
      ),
    ).toBe("close");
  });
  it("denies other applicants and administrators from different organizations when deciding requests", async () => {
    const { t, requestDoctor, researcher, organizationId, otherOrganizationId } = await setup();
    const request = await requestDoctor();
    const args = {
      actorId: "outside-admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "No access",
      idempotencyKey: "forbidden",
    };
    await expect(
      t.withIdentity({ subject: "outside-admin" }).mutation(api.organizationMembers.review, args),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      researcher.mutation(api.organizationMembers.withdraw, {
        actorId: "researcher",
        requestId: request._id,
        expectedRevision: 1,
        idempotencyKey: "foreign",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    expect(organizationId).not.toBe(otherOrganizationId);
  });
  it("rejects queued patient replay after suspension before reading a previously successful receipt", async () => {
    const { t, admin, doctor, organizationId, requestDoctor } = await setup();
    const request = await requestDoctor();
    await admin.mutation(api.organizationMembers.review, {
      actorId: "admin",
      requestId: request._id,
      expectedRevision: 1,
      approved: true,
      reason: "Checked",
      idempotencyKey: "approve",
    });
    const args = {
      actorId: "doctor",
      organizationId,
      clientId: crypto.randomUUID(),
      expectedRevision: 0,
      action: "create" as const,
      idempotencyKey: "old-clinical-operation",
      values: {
        fullName: "Private patient",
        birthDate: "1990-01-01",
        sex: "unknown" as const,
        diagnosisCodes: [],
        notes: "",
      },
    };
    expect(await doctor.mutation(api.patients.apply, args)).toEqual({ revision: 1 });
    const member = (
      await admin.query(api.organizationMembers.members, {
        actorId: "admin",
        organizationId,
        paginationOpts: page,
      })
    ).page.find((row) => row.userId === "doctor")!;
    await admin.mutation(api.organizationMembers.change, {
      actorId: "admin",
      membershipId: member.id,
      expectedRevision: 1,
      role: "doctor",
      active: false,
      reason: "Suspended",
      idempotencyKey: "suspend",
    });
    await expect(doctor.mutation(api.patients.apply, args)).rejects.toThrow("ACCESS_DENIED");
    expect(await t.run((ctx) => ctx.db.query("patients").collect())).toHaveLength(1);
    const profile = await doctor.query(api.profiles.mine, {});
    expect(
      workspaceAdmission(
        { userId: "doctor", organizationId, role: "doctor", expiresAt: 100 },
        {
          now: 50,
          localReady: true,
          localUserId: "doctor",
          sessionUserId: "doctor",
          isAuthenticated: true,
          online: true,
          profile,
        },
      ),
    ).toBe("close");
  });
  it("denies administrative access to a deleted organization even when an old membership remains", async () => {
    const { t, admin, organizationId } = await setup();
    await t.run((ctx) => ctx.db.delete(organizationId));
    await expect(
      admin.query(api.organizationMembers.members, {
        actorId: "admin",
        organizationId,
        paginationOpts: page,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
  });
});
