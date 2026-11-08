import type * as projectWork from "../projectWork.js";
import type * as projectTeams from "@/convex/projectTeams";
import type * as protocols from "@/convex/protocols";
import type * as projects from "@/convex/projects";
import type * as provisioning from "@/convex/provisioning";
import type * as patients from "@/convex/patients";
import type * as organizations from "@/convex/organizations";
import type * as profiles from "@/convex/profiles";
/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  projectTeams: typeof projectTeams;
  projectWork: typeof projectWork;
  projects: typeof projects;
  protocols: typeof protocols;
  profiles: typeof profiles;
  organizations: typeof organizations;
  patients: typeof patients;
  provisioning: typeof provisioning;
  auth: typeof auth;
  http: typeof http;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
