// Aggregated notification feed: pointers to actionable items only. The feed is
// derived from authoritative server state on every read and stores nothing;
// it never carries patient identity or clinical payloads.
export type NotificationKind = "invitation" | "task" | "safetyReview" | "visitWindow";
export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  projectClientId: string;
  projectTitle: string;
  dueOn: string;
  overdue: boolean;
  occurredAt: number;
}
export function sortNotifications(items: readonly NotificationItem[]) {
  return [...items].sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      a.occurredAt - b.occurredAt ||
      a.id.localeCompare(b.id),
  );
}
