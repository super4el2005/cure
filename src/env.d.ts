declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}
interface ImportMetaEnv {
  readonly PUBLIC_SENTRY_DSN?: string;
  readonly PUBLIC_SENTRY_RELEASE?: string;
  readonly PUBLIC_SENTRY_ENVIRONMENT?: string;
  readonly CONVEX_URL: string;
  readonly CONVEX_SITE_URL: string;
}
