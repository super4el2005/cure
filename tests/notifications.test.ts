import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
import { sortNotifications } from "@/src/lib/notification-model";
import type { NotificationItem } from "@/src/lib/notification-model";

const item = (overrides: Partial<NotificationItem>): NotificationItem => ({
  id: crypto.randomUUID(),
  kind: "task",
  title: "Task",
  detail: "",
  projectClientId: crypto.randomUUID(),
  projectTitle: "Study",
  dueOn: "",
  overdue: false,
  occurredAt: 1,
  ...overrides,
});
describe("notification ordering", () => {
  it("puts overdue items first, then earliest moment, then stable id order", () => {
    const rows = sortNotifications([
      item({ id: "b", occurredAt: 10 }),
      item({ id: "a", occurredAt: 10 }),
      item({ id: "c", overdue: true, occurredAt: 30 }),
      item({ id: "d", overdue: true, occurredAt: 20 }),
      item({ id: "e", occurredAt: 5 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["d", "c", "e", "a", "b"]);
  });
});

const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/notifications.ts": () => import("@/convex/notifications"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
const day = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const isoDays = (days: number) => new Date(Date.now() + days * day).toISOString().slice(0, 10);
describe("notification feed", () => {
  it("collects invitations, tasks, safety reviews and open visit windows for the actor only", async () => {
    const t = convexTest(schema, modules);
    const orgA = await t.mutation(internal.provisioning.createOrganization, {
      name: "Clinic",
      kind: "clinic",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    const orgB = await t.mutation(internal.provisioning.createOrganization, {
      name: "Other",
      kind: "hospital",
      country: "RU",
      city: "",
      description: "",
      published: false,
    });
    for (const [userId, organizationId, role] of [
      ["doctor", orgA, "doctor"],
      ["researcher", orgA, "researcher"],
      ["doctor", orgB, "researcher"],
    ] as const)
      await t.mutation(internal.provisioning.approveMembership, { userId, organizationId, role });
    const projectClientId = crypto.randomUUID();
    await t.run(async (ctx) => {
      await ctx.db.insert("projects", {
        clientId: projectClientId,
        organizationId: orgA,
        title: "Study",
        summary: "",
        topic: "",
        kind: "prospective",
        status: "recruiting",
        published: false,
        publicEligibility: "",
        publicContact: "",
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "doctor",
        updatedBy: "doctor",
      });
      for (const userId of ["doctor", "researcher"])
        await ctx.db.insert("projectMembers", {
          clientId: crypto.randomUUID(),
          projectClientId,
          userId,
          organizationId: orgA,
          role: "member",
          active: true,
          revision: 1,
        });
      await ctx.db.insert("collaborationInvites", {
        projectTitle: "Study",
        clientId: crypto.randomUUID(),
        projectClientId,
        inviteeId: "doctor",
        inviterId: "researcher",
        role: "member",
        status: "pending",
        expiresAt: Date.now() + 7 * day,
        revision: 1,
        createdAt: Date.now(),
      });
      // Expired and answered invitations never surface.
      await ctx.db.insert("collaborationInvites", {
        clientId: crypto.randomUUID(),
        projectClientId,
        inviteeId: "doctor",
        inviterId: "researcher",
        role: "viewer",
        status: "pending",
        expiresAt: Date.now() - day,
        revision: 1,
        createdAt: Date.now() - 8 * day,
      });
      await ctx.db.insert("collaborationInvites", {
        clientId: crypto.randomUUID(),
        projectClientId,
        inviteeId: "doctor",
        inviterId: "researcher",
        role: "viewer",
        status: "declined",
        expiresAt: Date.now() + 7 * day,
        revision: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("projectTasks", {
        clientId: crypto.randomUUID(),
        projectClientId,
        title: "Overdue task",
        description: "",
        status: "todo",
        priority: "high",
        assigneeId: "doctor",
        dueAt: Date.now() - 2 * day,
        archived: false,
        revision: 1,
        createdBy: "researcher",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("projectTasks", {
        clientId: crypto.randomUUID(),
        projectClientId,
        title: "Done task",
        description: "",
        status: "done",
        priority: "low",
        assigneeId: "doctor",
        dueAt: Date.now() - day,
        archived: false,
        revision: 1,
        createdBy: "researcher",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("projectTasks", {
        clientId: crypto.randomUUID(),
        projectClientId,
        title: "Researcher task",
        description: "",
        status: "todo",
        priority: "normal",
        assigneeId: "researcher",
        dueAt: 0,
        archived: false,
        revision: 1,
        createdBy: "doctor",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const issuePayload = (reviewerId: string) => ({
        kind: "studyIssue" as const,
        writeId: crypto.randomUUID(),
        occurredOn: today(),
        notes: "",
        projectClientId,
        enrollmentClientId: crypto.randomUUID(),
        protocolClientId: crypto.randomUUID(),
        protocolVersion: 1,
        detectedOn: today(),
        title: "Adverse event review",
        description: "Private description",
        status: "open" as const,
        reviewerId,
        reviewDueOn: isoDays(-1),
        resolution: "",
        reviewedOn: "",
        reviewedBy: "",
        amendmentReason: "",
        details: {
          type: "deviation" as const,
          impact: "minor" as const,
          protocolSection: "5",
          rootCause: "",
          correctiveAction: "",
          preventiveAction: "",
        },
      });
      const visitPayload = {
        kind: "studyVisit" as const,
        writeId: crypto.randomUUID(),
        occurredOn: today(),
        notes: "",
        enrollmentClientId: crypto.randomUUID(),
        enrollmentWriteId: crypto.randomUUID(),
        projectClientId,
        protocolClientId: crypto.randomUUID(),
        protocolVersion: 1,
        windowFrom: isoDays(-1),
        windowTo: isoDays(2),
        performedOn: "",
        deviationReason: "",
        amendmentReason: "",
        scheduledFor: `${today()}T12:00:00+00:00[UTC]`,
        durationMinutes: 30,
        visitType: "consultation" as const,
        status: "planned" as const,
        reason: "Baseline visit",
        location: "",
        outcome: "",
        followUpOn: "",
        cancellationReason: "",
      };
      const patientClientId = crypto.randomUUID();
      let revision = 0;
      const insertRecord = (
        organizationId: typeof orgA,
        payload: ReturnType<typeof issuePayload> | typeof visitPayload,
      ) =>
        ctx.db.insert("clinicalRecords", {
          organizationId,
          clientId: crypto.randomUUID(),
          patientClientId,
          payload,
          revision: ++revision,
          deleted: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updatedBy: "doctor",
        });
      await insertRecord(orgA, issuePayload("doctor"));
      await insertRecord(orgA, visitPayload);
      // Not assigned to the physician and outside physician organizations.
      await insertRecord(orgA, issuePayload("researcher"));
      await insertRecord(orgB, issuePayload("doctor"));
    });
    const doctor = t.withIdentity({ subject: "doctor" });
    const feed = await doctor.query(api.notifications.feed, { actorId: "doctor" });
    expect(feed.map((row) => row.kind)).toEqual([
      "task",
      "safetyReview",
      "visitWindow",
      "invitation",
    ]);
    expect(feed[0]).toMatchObject({
      title: "Overdue task",
      overdue: true,
      projectClientId,
      projectTitle: "Study",
    });
    expect(feed[1]).toMatchObject({
      title: "Adverse event review",
      detail: "deviation",
      dueOn: isoDays(-1),
      overdue: true,
    });
    expect(feed[2]).toMatchObject({
      title: "Baseline visit",
      detail: `${isoDays(-1)} — ${isoDays(2)}`,
      overdue: false,
    });
    expect(feed[3]).toMatchObject({ kind: "invitation", projectTitle: "Study", overdue: false });
    expect(JSON.stringify(feed)).not.toMatch(/Private|patientClientId|reviewerId|inviteeId/);
    const researcher = t.withIdentity({ subject: "researcher" });
    const researcherFeed = await researcher.query(api.notifications.feed, {
      actorId: "researcher",
    });
    expect(researcherFeed.map((row) => row.kind)).toEqual(["task"]);
    await expect(researcher.query(api.notifications.feed, { actorId: "doctor" })).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    await expect(t.query(api.notifications.feed, { actorId: "doctor" })).rejects.toThrow(
      "UNAUTHENTICATED",
    );
  });
});
