import { describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { lockClinicalAccess } from "@/src/lib/clinical-identity";
import { authenticatedDetector } from "@/src/lib/offline-admission";
import {
  retainWorkspace,
  releaseWorkspaces,
  retainedWorkspaceOptions,
} from "@/src/lib/retained-workspaces";
import type { RetainedWorkspace } from "@/src/lib/retained-workspaces";
import { workspaceAdmission } from "@/src/lib/workspace-admission";

function resource(kind: RetainedWorkspace["kind"], userId: string) {
  let locked = false;
  const close = rstest.fn(async () => {
    locked = true;
  });
  const workspace = {
    close,
    read() {
      if (locked) throw new Error("VAULT_LOCKED");
      return "data";
    },
  };
  return { entry: { kind, userId, workspace } as unknown as RetainedWorkspace, workspace };
}
describe("unlocked workspace lifetime", () => {
  it("retains an open resource when a page observer unmounts, and closes all kinds on explicit lock", async () => {
    const client = new QueryClient();
    const root = new QueryObserver(client, retainedWorkspaceOptions);
    const unsubscribeRoot = root.subscribe(() => {});
    const page = new QueryObserver(client, retainedWorkspaceOptions);
    const unsubscribePage = page.subscribe(() => {});
    const patients = resource("patients", "doctor");
    const projects = resource("projects", "doctor");
    await retainWorkspace(client, patients.entry);
    await retainWorkspace(client, projects.entry);
    unsubscribePage();
    expect(client.getQueryData(retainedWorkspaceOptions.queryKey)).toHaveLength(2);
    expect(patients.workspace.read()).toBe("data");
    expect(patients.workspace.close).not.toHaveBeenCalled();
    await lockClinicalAccess(client);
    expect(patients.workspace.close).toHaveBeenCalledOnce();
    expect(projects.workspace.close).toHaveBeenCalledOnce();
    expect(() => patients.workspace.read()).toThrow("VAULT_LOCKED");
    expect(client.getQueryData(retainedWorkspaceOptions.queryKey)).toEqual([]);
    unsubscribeRoot();
    client.clear();
  });
  it("wipes an old scope before publishing a replacement and can revoke one workspace", async () => {
    const client = new QueryClient();
    const old = resource("patients", "first");
    const next = resource("patients", "second");
    const projects = resource("projects", "second");
    await retainWorkspace(client, old.entry);
    await retainWorkspace(client, projects.entry);
    await retainWorkspace(client, next.entry);
    expect(() => old.workspace.read()).toThrow("VAULT_LOCKED");
    expect(next.workspace.read()).toBe("data");
    await releaseWorkspaces(client, (entry) => entry.kind === "patients");
    expect(next.workspace.close).toHaveBeenCalledOnce();
    expect(projects.workspace.close).not.toHaveBeenCalled();
    await releaseWorkspaces(client);
    client.clear();
  });
  it("does not reset transport backoff when an unchanged authorization state is observed", () => {
    const notifyOnline = rstest.fn();
    const detector = authenticatedDetector(
      { isOnline: () => true, notifyOnline, dispose() {}, subscribe: () => () => {} },
      Date.now() + 60000,
    );
    expect(detector.isOnline()).toBe(false);
    detector.setAuthenticated(true);
    detector.setAuthenticated(true);
    expect(detector.isOnline()).toBe(true);
    expect(notifyOnline).toHaveBeenCalledOnce();
    detector.setAuthenticated(false);
    expect(detector.isOnline()).toBe(false);
    expect(notifyOnline).toHaveBeenCalledTimes(2);
    detector.requireAuthentication();
    detector.setAuthenticated(true);
    expect(detector.isOnline()).toBe(false);
    expect(detector.requiresAuthentication()).toBe(true);
    detector.confirmAuthentication();
    expect(detector.isOnline()).toBe(true);
  });
});

describe("workspace authorization lifecycle", () => {
  const workspace = { userId: "doctor", organizationId: "clinic", role: "doctor", expiresAt: 100 };
  const signals = {
    now: 50,
    localReady: true,
    localUserId: "doctor",
    sessionUserId: "doctor",
    isAuthenticated: true,
    online: true,
    profile: { userId: "doctor", memberships: [{ organizationId: "clinic", role: "doctor" }] },
  };
  it("pauses on a transient session failure and closes on expiry, account switch or explicit local logout", () => {
    expect(workspaceAdmission(workspace, signals)).toBe("sync");
    expect(
      workspaceAdmission(workspace, {
        ...signals,
        sessionUserId: undefined,
        isAuthenticated: false,
        online: false,
      }),
    ).toBe("pause");
    expect(workspaceAdmission(workspace, { ...signals, now: 100 })).toBe("close");
    expect(workspaceAdmission(workspace, { ...signals, sessionUserId: "other" })).toBe("close");
    expect(workspaceAdmission(workspace, { ...signals, localUserId: undefined })).toBe("close");
  });
  it("revokes current authoritative membership and ignores another account's stale cached profile", () => {
    expect(
      workspaceAdmission(workspace, {
        ...signals,
        profile: { ...signals.profile, memberships: [] },
      }),
    ).toBe("close");
    expect(
      workspaceAdmission(workspace, { ...signals, profile: { userId: "other", memberships: [] } }),
    ).toBe("sync");
    expect(
      workspaceAdmission(workspace, {
        ...signals,
        online: false,
        profile: { ...signals.profile, memberships: [] },
      }),
    ).toBe("pause");
  });
});

it("keeps a personal library independent of institution membership while closing expired or changed identities", () => {
  const personal = { userId: "doctor", purpose: "library" as const, expiresAt: 100 };
  const signals = {
    now: 50,
    localReady: true,
    localUserId: "doctor",
    sessionUserId: "doctor",
    isAuthenticated: true,
    online: true,
    profile: { userId: "doctor", memberships: [], profile: { profession: "doctor" } },
  };
  expect(workspaceAdmission(personal, signals)).toBe("sync");
  expect(
    workspaceAdmission(personal, {
      ...signals,
      profile: { ...signals.profile, profile: { profession: "researcher" } },
    }),
  ).toBe("sync");
  expect(
    workspaceAdmission(personal, { ...signals, profile: { ...signals.profile, profile: null } }),
  ).toBe("close");
  expect(
    workspaceAdmission(personal, {
      ...signals,
      online: false,
      isAuthenticated: false,
      sessionUserId: undefined,
      profile: undefined,
    }),
  ).toBe("pause");
  expect(workspaceAdmission(personal, { ...signals, now: 100 })).toBe("close");
  expect(workspaceAdmission(personal, { ...signals, sessionUserId: "another" })).toBe("close");
  expect(workspaceAdmission(personal, { ...signals, localUserId: undefined })).toBe("close");
});

it("closes a retained personal library on explicit logout without losing its owner scope", async () => {
  const client = new QueryClient();
  const library = resource("library", "doctor");
  await retainWorkspace(client, library.entry);
  expect(library.workspace.read()).toBe("data");
  await lockClinicalAccess(client);
  expect(library.workspace.close).toHaveBeenCalledOnce();
  expect(() => library.workspace.read()).toThrow("VAULT_LOCKED");
  client.clear();
});
