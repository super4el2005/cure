import { describe, expect, it } from "@rstest/core";
import { convexTest } from "convex-test";

import { api, internal } from "@/convex/_generated/api";
import schema from "@/convex/schema";
const modules = {
  "../convex/_generated/server.js": () => import("@/convex/_generated/server.js"),
  "../convex/profiles.ts": () => import("@/convex/profiles"),
  "../convex/organizations.ts": () => import("@/convex/organizations"),
  "../convex/provisioning.ts": () => import("@/convex/provisioning"),
};
describe("public detail privacy", () => {
  it("requires a verified published profile and returns an explicit public projection", async () => {
    const t = convexTest(schema, modules);
    const actor = t.withIdentity({ subject: "private-account-id" });
    const profile = {
      displayName: "Researcher",
      profession: "researcher" as const,
      specialty: "Medicine",
      interests: ["Public health"],
      languages: ["en"],
      bio: "Public biography",
      published: true,
    };
    const id = await actor.mutation(api.profiles.save, profile);
    expect(await t.query(api.profiles.publicDetails, { id })).toBeNull();
    await t.mutation(internal.provisioning.verifyProfile, {
      userId: "private-account-id",
      verified: true,
    });
    const result = await t.query(api.profiles.publicDetails, { id });
    expect(result?.displayName).toBe(profile.displayName);
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("updatedAt");
    expect(result).not.toHaveProperty("memberships");
    await actor.mutation(api.profiles.save, { ...profile, published: false });
    expect(await t.query(api.profiles.publicDetails, { id })).toBeNull();
    expect(await t.query(api.profiles.publicDetails, { id: "invalid" })).toBeNull();
  });
  it("does not expose unpublished organizations, internal document fields or cross-table ids", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.provisioning.createOrganization, {
      name: "Clinic",
      kind: "clinic",
      country: "RU",
      city: "Samara",
      description: "Public description",
      published: false,
    });
    expect(await t.query(api.organizations.publicDetails, { id })).toBeNull();
    await t.run((ctx) => ctx.db.patch(id, { published: true }));
    const result = await t.query(api.organizations.publicDetails, { id });
    expect(result).toEqual({
      id,
      name: "Clinic",
      kind: "clinic",
      country: "RU",
      city: "Samara",
      description: "Public description",
    });
    expect(await t.query(api.profiles.publicDetails, { id })).toBeNull();
    expect(await t.query(api.organizations.publicDetails, { id: "invalid" })).toBeNull();
  });
});
