import { createCollection, localStorageCollectionOptions } from "@tanstack/db";

import type { AiProvider } from "@/src/lib/ai-providers";

// Device-only demo and preferences, not user edits synchronized with Convex.
export const aiDefaults = {
  id: "preferences",
  provider: "gigachat" as AiProvider,
  model: "GigaChat",
  baseURL: "",
};
export type AiPreferences = typeof aiDefaults;

export function createDeviceCounter(storage: Storage) {
  return createCollection(
    localStorageCollectionOptions<{ id: string; count: number }>({
      id: "cure-device-demo-counter-v1",
      storageKey: "cure.device-demo-counter.v1",
      storage,
      getKey: (row) => row.id,
    }),
  );
}
export function createAiPreferences(userId: string, storage: Storage) {
  return createCollection(
    localStorageCollectionOptions<AiPreferences>({
      id: `cure-ai-preferences-${userId}`,
      storageKey: `cure.ai-preferences.v1.${userId}`,
      storage,
      getKey: (row) => row.id,
    }),
  );
}
