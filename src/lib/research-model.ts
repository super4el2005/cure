import { z } from "zod";

export const researchKindSchema = z.enum([
  "retrospective",
  "prospective",
  "interventional",
  "registry",
]);
export const researchStatusSchema = z.enum([
  "draft",
  "preparing",
  "recruiting",
  "active",
  "completed",
  "archived",
]);
export const projectValuesSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(5000),
  topic: z.string().trim().max(300),
  kind: researchKindSchema,
  status: researchStatusSchema,
  published: z.boolean(),
  publicEligibility: z.string().trim().max(5000),
  publicContact: z.string().trim().max(1000),
});
export type ProjectValues = z.infer<typeof projectValuesSchema>;
export const projectRoleSchema = z.enum(["owner", "coordinator", "member", "viewer"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export const researchTransitions: Record<ProjectValues["status"], ProjectValues["status"][]> = {
  draft: ["preparing", "archived"],
  preparing: ["draft", "recruiting", "active", "archived"],
  recruiting: ["preparing", "active", "archived"],
  active: ["completed", "archived"],
  completed: ["archived"],
  archived: ["preparing"],
};
export function validateResearchTransition(
  previous: ProjectValues["status"],
  next: ProjectValues["status"],
  role: ProjectRole,
) {
  if (previous === next) return;
  if (
    !researchTransitions[previous].includes(next) ||
    ((next === "archived" || previous === "archived") && role !== "owner")
  )
    throw new Error("INVALID_RESEARCH_TRANSITION");
}
export const protocolValuesSchema = z
  .object({
    hypothesis: z.string().trim().min(1).max(5000),
    inclusion: z.string().trim().max(5000),
    exclusion: z.string().trim().max(5000),
    endpoints: z.string().trim().min(1).max(5000),
    analysisPlan: z.string().trim().min(1).max(10000),
    ethicsApproved: z.boolean(),
    ethicsReference: z.string().trim().max(1000),
    ethicsExpiresAt: z.number().finite().nonnegative(),
  })
  .refine((value) => !value.ethicsApproved || value.ethicsReference.length > 0);
export type ProtocolValues = z.infer<typeof protocolValuesSchema>;
