import type { Doc } from "@/convex/_generated/dataModel";
import type { QueryCtx } from "@/convex/_generated/server";

export async function publicResearch(ctx: QueryCtx, project: Doc<"projects">) {
  if (!project.published || project.status === "draft" || project.status === "archived")
    return null;
  const organization = await ctx.db.get(project.organizationId);
  if (!organization?.published) return null;
  const protocol =
    project.status === "recruiting"
      ? await ctx.db
          .query("studyProtocols")
          .withIndex("by_project_version", (q) => q.eq("projectClientId", project.clientId))
          .order("desc")
          .first()
      : null;
  const recruitmentOpen =
    project.status === "recruiting" &&
    Boolean(
      protocol?.ethicsApproved && protocol.ethicsReference && protocol.ethicsExpiresAt > Date.now(),
    );
  return {
    id: project.clientId,
    title: project.title,
    summary: project.summary,
    topic: project.topic,
    kind: project.kind,
    status:
      project.status === "recruiting" && !recruitmentOpen ? ("preparing" as const) : project.status,
    recruitmentOpen,
    recruitmentUntil: recruitmentOpen ? protocol!.ethicsExpiresAt : 0,
    country: organization.country,
    organization: organization.name,
    publicEligibility: project.publicEligibility,
    publicContact: project.publicContact,
    createdAt: project.createdAt,
  };
}
