import type { OnlineDetector, StorageAdapter } from "@tanstack/offline-transactions";
import { z } from "zod";

export function authenticatedDetector(base: OnlineDetector, expiresAt: number) {
  let authenticated = false;
  return {
    ...base,
    subscribe: (callback: () => void) => base.subscribe(callback),
    notifyOnline: () => base.notifyOnline(),
    isOnline: () => authenticated && Date.now() < expiresAt && base.isOnline(),
    dispose: () => base.dispose(),
    setAuthenticated(value: boolean) {
      authenticated = value;
      base.notifyOnline();
    },
  };
}

// Offline transactions expose server settlement, not a local persistence receipt.
// This adapter acknowledges the documented serialized transaction id only AFTER
// StorageAdapter.set has completed. It neither schedules nor replays mutations.
export function durabilityReceipts(storage: StorageAdapter) {
  const pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  return {
    storage: {
      ...storage,
      async set(key: string, value: string) {
        const parsed = z.object({ id: z.string() }).parse(JSON.parse(value));
        try {
          await storage.set(key, value);
          pending.get(parsed.id)?.resolve();
        } catch (error) {
          pending.get(parsed.id)?.reject(error);
          throw error;
        } finally {
          pending.delete(parsed.id);
        }
      },
    },
    wait(id: string) {
      return new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    cancel(id: string) {
      pending.delete(id);
    },
    dispose() {
      for (const waiter of pending.values()) waiter.reject(new Error("WORKSPACE_LOCKED"));
      pending.clear();
    },
  };
}
