export function workspaceAdmission(
  workspace: {
    userId: string;
    organizationId?: string;
    role?: string;
    purpose?: "library";
    expiresAt: number;
  },
  signals: {
    now: number;
    localReady: boolean;
    localUserId: string | undefined;
    sessionUserId: string | undefined;
    isAuthenticated: boolean;
    online: boolean;
    profile:
      | {
          userId: string;
          memberships: readonly { organizationId: string; role: string }[];
          profile?: { profession: string } | null;
        }
      | undefined;
  },
): "close" | "pause" | "sync" {
  if (
    signals.now >= workspace.expiresAt ||
    (signals.localReady && signals.localUserId !== workspace.userId) ||
    (signals.sessionUserId && signals.sessionUserId !== workspace.userId) ||
    (signals.isAuthenticated &&
      signals.online &&
      signals.profile?.userId === workspace.userId &&
      (workspace.purpose === "library"
        ? !signals.profile.profile ||
          !["doctor", "researcher"].includes(signals.profile.profile.profession)
        : !signals.profile.memberships.some(
            (member) =>
              member.organizationId === workspace.organizationId && member.role === workspace.role,
          )))
  )
    return "close";
  return signals.isAuthenticated &&
    signals.online &&
    signals.sessionUserId === workspace.userId &&
    signals.localUserId === workspace.userId
    ? "sync"
    : "pause";
}
