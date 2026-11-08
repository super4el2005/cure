import type { Options, StreamedSpanJSON } from "@sentry/core";
import type { Breadcrumb, ErrorEvent, Log } from "@sentry/tanstackstart-react";

// One catalog for semantic user actions. Never derive event names from user input.
export const actions: Record<string, string> = {
  authentication: "account.authentication",
  "profile-save": "profile.save",
  "patients-open": "patients.open",
  "patients-save": "patients.save",
  "patients-delete": "patients.delete",
  "patients-lock": "patients.lock",
  "patients-resume": "patients.resume",
  "patients-share": "patients.share",
  "patients-consent": "patients.consent",
  "patients-restore": "patients.restore",
  "task-save": "task.save",
  "message-save": "message.save",
  "project-work-action": "work.action",
  "project-work-restore": "work.restore",
  "team-save": "team.save",
  "team-invite": "team.invite",
  "team-restore": "team.restore",
  "protocol-save": "protocol.save",
  "protocol-restore": "protocol.restore",
  "projects-open": "projects.open",
  "projects-save": "projects.save",
  "projects-resume": "projects.resume",
  "projects-lock": "projects.lock",
  "projects-restore": "projects.restore",
  "research-loadmore": "research.loadmore",
  appearance: "preferences.theme",
  language: "preferences.language",
  "device-counter": "counter.increment",
  "ai-preferences": "ai.preferences.save",
  "ai-key": "ai.key.update",
  "ai-connection-check": "ai.connection.check",
  "save-medical-records": "catalog.persist",
  searchMedical: "catalog.search",
  "install-pwa": "pwa.install",
  "pwa-registration": "pwa.register",
};
export const errorCodes = new Set([
  "FORBIDDEN_ORIGIN",
  "INVALID_REQUEST",
  "INVALID_SEARCH",
  "INVALID_CONTENT_TYPE",
  "INVALID_MODEL",
  "REQUEST_TOO_LARGE",
  "UNAUTHENTICATED",
  "AUTH_UNAVAILABLE",
  "SOURCE_NOT_CONFIGURED",
  "SOURCE_AUTH_FAILED",
  "SOURCE_UNAVAILABLE",
  "SOURCE_RATE_LIMITED",
  "INVALID_SOURCE_RESPONSE",
  "AI_NOT_CONFIGURED",
  "AI_TLS_ERROR",
  "AI_PROVIDER_UNAUTHORIZED",
  "AI_RATE_LIMITED",
  "AI_TIMEOUT",
  "AI_UNAVAILABLE",
  "SIGN_IN_FAILED",
  "SIGN_OUT_FAILED",
  "STORAGE_UNAVAILABLE",
  "ACCOUNT_CHANGED",
  "INTERNAL_ERROR",
  "ACCESS_DENIED",
  "WORKSPACE_NOT_READY",
  "INVALID_TASK",
  "ASSIGNEE_UNAVAILABLE",
  "INVALID_MESSAGE",
  "MESSAGE_DELETED",
  "PROJECT_ARCHIVED",
  "INVALID_WORK_OPERATION",
  "INVALID_TEAM_OPERATION",
  "INVITEE_UNAVAILABLE",
  "ALREADY_MEMBER",
  "INVITE_ALREADY_PENDING",
  "INVITE_EXPIRED",
  "INVITE_NOT_PENDING",
  "AFFILIATION_REQUIRED",
  "NEW_INVITATION_REQUIRED",
  "INVALID_PROTOCOL",
  "PROJECT_COMPLETED",
  "INVALID_PROJECT",
  "INVALID_RESEARCH_TRANSITION",
  "PROJECT_NOT_PUBLISHABLE",
  "ETHICS_APPROVAL_REQUIRED",
  "PROJECT_SYNC_REJECTED",
  "PROJECT_SYNC_UNCONFIRMED",
  "PATIENT_NOT_FOUND",
  "INVALID_PATIENT",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "INVALID_PROFILE",
  "VERIFIED_ROLE_CHANGE_REQUIRES_REVIEW",
  "INVALID_GRANT",
  "INVALID_CONSENT",
  "CONSENT_EXPIRED",
  "CONSENT_HISTORY_IMMUTABLE",
  "INVALID_CONSENT_RECIPIENT",
  "CONSENT_REQUIRED",
  "VAULT_LOCKED",
  "VAULT_UNLOCK_FAILED",
  "INVALID_VAULT_DATA",
  "INVALID_VAULT_PASSPHRASE",
  "WORKSPACE_LOCKED",
  "OFFLINE_NOT_PREPARED",
  "OFFLINE_ACCESS_EXPIRED",
  "WORKSPACE_READ_ONLY_TAB",
  "PATIENT_SYNC_REJECTED",
  "PATIENT_SYNC_UNCONFIRMED",
  "PERSISTENCE_FAILED",
  "RUNTIME_ERROR",
  "NETWORK_ERROR",
  "CANCELLED",
  "HTTP_ERROR",
]);
const paths = new Set([
  "/",
  "/d",
  "/m",
  "/auth/error",
  "/api/medical/search",
  "/api/ai/chat",
  "/_shell.html",
]);
export function safePath(value: unknown): string {
  try {
    const path = new URL(typeof value === "string" ? value : "/", "https://application.invalid")
      .pathname;
    if (paths.has(path)) return path;
    if (
      /^\/[dm]\/(profile|patients|projects|invitations|specialists|organizations|research|tools)$/.test(
        path,
      )
    )
      return path;
    const detail = path.match(
      /^\/([dm])\/(patients|projects|research|specialists|organizations)\/[^/]+(?:\/(consents|protocol|team|work))?$/,
    );
    if (
      detail &&
      (!detail[3] ||
        (detail[2] === "patients" && detail[3] === "consents") ||
        (detail[2] === "projects" && ["protocol", "team", "work"].includes(detail[3])))
    )
      return `/${detail[1]}/${detail[2]}/:id${detail[3] ? `/${detail[3]}` : ""}`;

    if (path.startsWith("/api/auth/")) return "/api/auth/:action";
    if (path.startsWith("/_serverFn/")) return "/_serverFn/:function";
    if (path.startsWith("/icd/")) return "/icd/:classification";
    if (path.startsWith("/rd-cross-referencing/")) return "/rd-cross-referencing/:operation";
    if (path.startsWith("/entrez/")) return "/entrez/:operation";
    return "/:redacted";
  } catch {
    return "/:redacted";
  }
}
const attributeKeys = new Set([
  "app.operation",
  "app.outcome",
  "app.code",
  "app.route",
  "app.request_id",
  "app.duration_ms",
  "http.request.method",
  "http.response.status_code",
  "sentry.op",
  "sentry.origin",
  "sentry.segment.name.source",
  "sentry.sample_rate",
  "sentry.kind",
  "sentry.status_code",
]);
export function safeAttributes(
  values: Record<string, unknown> = {},
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => {
      const [key, value] = entry;
      if (key === "app.code") return typeof value === "string" && errorCodes.has(value);
      if (key === "app.route") return typeof value === "string" && safePath(value) === value;
      if (key === "app.outcome")
        return ["success", "error", "cancelled", "rejected"].includes(String(value));
      if (key === "app.request_id")
        return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
      if (key === "app.operation")
        return (
          typeof value === "string" &&
          (Object.values(actions).includes(value) ||
            [
              "patients.close",
              "patients.sync",
              "patients.queue",
              "storage.clinical",
              "directory.open",
              "directory.close",
              "query.load",
              "route.render",
              "user.operation",
              "storage.counter",
              "storage.catalog",
              "storage.preferences",
            ].includes(value) ||
            (value.startsWith("navigation") && safePath(value.slice(10)) === value.slice(10)) ||
            (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(value) &&
              safePath(value.slice(value.indexOf(" ") + 1)) ===
                value.slice(value.indexOf(" ") + 1)))
        );
      return (
        attributeKeys.has(key) &&
        ((typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean" ||
          (typeof value === "string" && value.length <= 100))
      );
    }),
  );
}
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "app.action")
    return {
      category: crumb.category,
      ...(crumb.timestamp !== undefined ? { timestamp: crumb.timestamp } : {}),
      message: "app.operation",
      data: safeAttributes(crumb.data),
    };
  if (crumb.category === "navigation")
    return {
      category: "navigation",
      ...(crumb.timestamp !== undefined ? { timestamp: crumb.timestamp } : {}),
      data: { from: safePath(crumb.data?.from), to: safePath(crumb.data?.to) },
    };
  // SDK DOM/console/network breadcrumbs may contain diagnoses, URLs or SDK keys.
  return null;
}
export function scrubError(event: ErrorEvent): ErrorEvent {
  delete event.user;
  delete event.extra;
  delete event.request;
  delete event.server_name;
  delete event.logentry;
  delete event.message;
  delete event.fingerprint;
  const trace = event.contexts?.trace;
  event.contexts = trace
    ? { trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: "app.operation" } }
    : {};
  event.tags = safeAttributes(event.tags);
  event.transaction = safePath(event.transaction);
  if (event.breadcrumbs)
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((value): value is Breadcrumb => value !== null);
  for (const exception of event.exception?.values ?? []) {
    if (exception.mechanism) delete exception.mechanism.data;
    exception.type = /^[A-Za-z][A-Za-z0-9_.]{0,64}$/.test(exception.type ?? "")
      ? exception.type!
      : "Error";
    exception.value = errorCodes.has(String(event.tags["app.code"]))
      ? String(event.tags["app.code"])
      : "RUNTIME_ERROR";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.post_context;
      delete frame.context_line;
      if (frame.filename) frame.filename = frame.filename.split(/[?#]/)[0]!;
      if (frame.abs_path) frame.abs_path = frame.abs_path.split(/[?#]/)[0]!;
    }
  }
  return event;
}
export function scrubSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  const operation = span.attributes["app.operation"];
  return {
    ...span,
    name:
      typeof operation === "string" && Object.values(actions).includes(operation)
        ? operation
        : safePath(span.name.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")),
    attributes: safeAttributes(span.attributes),
    links: [],
  };
}
export function scrubLog(log: Log): Log | null {
  // Only our fixed event vocabulary enters Sentry Logs, never arbitrary console text.
  if (log.message !== "app.operation") return null;
  return { ...log, attributes: safeAttributes(log.attributes) };
}
export function telemetryOptions(): Pick<
  Options,
  | "dataCollection"
  | "beforeSend"
  | "beforeBreadcrumb"
  | "beforeSendSpan"
  | "beforeSendLog"
  | "beforeSendMetric"
  | "maxBreadcrumbs"
> {
  return {
    maxBreadcrumbs: 30,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
    },
    beforeSend: scrubError,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendSpan: scrubSpan,
    beforeSendLog: scrubLog,
    beforeSendMetric: (metric) =>
      metric.name.startsWith("app.")
        ? { ...metric, attributes: safeAttributes(metric.attributes) }
        : null,
  };
}
