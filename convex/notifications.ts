import { ConvexError, v } from "convex/values";

import { query } from "@/convex/_generated/server";
import { actorId } from "@/convex/lib/access";
import { sortNotifications } from "@/src/lib/notification-model";
import type { NotificationItem } from "@/src/lib/notification-model";
// Derived pointers to open work: pending invitations, assigned open tasks,
// safety reviews assigned to the physician and study visits whose window has
// opened. Clinical entries appear only for organizations where the user is an
// active verified physician, and never include patient identity.
export const feed = query({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const userId = await actorId(ctx);
    if (userId !== args.actorId) throw new ConvexError("ACCOUNT_CHANGED");
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const items: NotificationItem[] = [];
    const projectTitles = new Map<string, string>();
    const projectTitle = async (projectClientId: string) => {
      if (!projectTitles.has(projectClientId)) {
        const project = await ctx.db
          .query("projects")
          .withIndex("by_client", (q) => q.eq("clientId", projectClientId))
          .unique();
        projectTitles.set(projectClientId, project?.title ?? "");
      }
      return projectTitles.get(projectClientId)!;
    };
    const invitations = await ctx.db
      .query("collaborationInvites")
      .withIndex("by_recipient", (q) => q.eq("inviteeId", userId))
      .collect();
    for (const invitation of invitations) {
      if (invitation.status !== "pending" || invitation.expiresAt <= now) continue;
      const title = invitation.projectTitle ?? (await projectTitle(invitation.projectClientId));
      items.push({
        id: `invitation:${invitation.clientId}`,
        kind: "invitation",
        title,
        detail: invitation.role,
        projectClientId: invitation.projectClientId,
        projectTitle: title,
        dueOn: new Date(invitation.expiresAt).toISOString().slice(0, 10),
        overdue: false,
        occurredAt: invitation.expiresAt,
      });
    }
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const activeProjects = memberships
      .filter((member) => member.active)
      .map((member) => member.projectClientId);
    for (const projectClientId of activeProjects) {
      const tasks = await ctx.db
        .query("projectTasks")
        .withIndex("by_project", (q) => q.eq("projectClientId", projectClientId))
        .collect();
      for (const task of tasks) {
        if (
          task.assigneeId !== userId ||
          task.archived ||
          (task.status !== "todo" && task.status !== "inProgress")
        )
          continue;
        items.push({
          id: `task:${task.clientId}`,
          kind: "task",
          title: task.title,
          detail: task.priority,
          projectClientId,
          projectTitle: await projectTitle(projectClientId),
          dueOn: task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : "",
          overdue: task.dueAt > 0 && task.dueAt < now,
          occurredAt: task.dueAt || task.updatedAt,
        });
      }
    }
    const organizations = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const doctorOrgs = new Set(
      organizations
        .filter((row) => row.active && row.verified && row.role === "doctor")
        .map((row) => row.organizationId as string),
    );
    if (doctorOrgs.size) {
      const issues = await ctx.db
        .query("clinicalRecords")
        .withIndex("by_kind_active", (q) => q.eq("payload.kind", "studyIssue").eq("deleted", false))
        .collect();
      for (const row of issues) {
        const payload = row.payload;
        if (
          payload?.kind !== "studyIssue" ||
          payload.reviewerId !== userId ||
          (payload.status !== "open" && payload.status !== "underReview") ||
          !doctorOrgs.has(row.organizationId)
        )
          continue;
        items.push({
          id: `safetyReview:${row.clientId}`,
          kind: "safetyReview",
          title: payload.title,
          detail: payload.details.type,
          projectClientId: payload.projectClientId,
          projectTitle: await projectTitle(payload.projectClientId),
          dueOn: payload.reviewDueOn,
          overdue: payload.reviewDueOn < today,
          occurredAt: Date.parse(`${payload.reviewDueOn}T00:00:00Z`),
        });
      }
      const visits = await ctx.db
        .query("clinicalRecords")
        .withIndex("by_kind_active", (q) => q.eq("payload.kind", "studyVisit").eq("deleted", false))
        .take(500);
      for (const row of visits) {
        const payload = row.payload;
        if (
          payload?.kind !== "studyVisit" ||
          (payload.status !== "planned" && payload.status !== "inProgress") ||
          payload.windowFrom > today ||
          !doctorOrgs.has(row.organizationId)
        )
          continue;
        items.push({
          id: `visitWindow:${row.clientId}`,
          kind: "visitWindow",
          title: payload.reason,
          detail: `${payload.windowFrom} — ${payload.windowTo}`,
          projectClientId: payload.projectClientId,
          projectTitle: await projectTitle(payload.projectClientId),
          dueOn: payload.windowTo,
          overdue: payload.windowTo < today,
          occurredAt: Date.parse(`${payload.windowFrom}T00:00:00Z`),
        });
      }
    }
    return sortNotifications(items).slice(0, 100);
  },
});
