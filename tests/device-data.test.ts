import { expect, it } from "@rstest/core";

import { aiDefaults, createAiPreferences, createDeviceCounter } from "@/src/lib/device-data";

function deviceStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

it("retains the existing device counter storage across collection recreation", async () => {
  const storage = deviceStorage();
  const first = createDeviceCounter(storage);
  await first.toArrayWhenReady();
  await first.insert({ id: "counter", count: 2 }).when("settled");
  await first.cleanup();
  const restored = createDeviceCounter(storage);
  expect(await restored.toArrayWhenReady()).toMatchObject([{ id: "counter", count: 2 }]);
  await restored
    .update("counter", (draft) => {
      draft.count += 1;
    })
    .when("settled");
  await restored.cleanup();
  const next = createDeviceCounter(storage);
  expect(await next.toArrayWhenReady()).toMatchObject([{ id: "counter", count: 3 }]);
  await next.cleanup();
});

it("restores AI preferences within their account namespace without mixing users", async () => {
  const storage = deviceStorage();
  const userA = createAiPreferences("user-a", storage);
  const userB = createAiPreferences("user-b", storage);
  await Promise.all([userA.toArrayWhenReady(), userB.toArrayWhenReady()]);
  await userA.insert({ ...aiDefaults, provider: "openai", model: "user-a-model" }).when("settled");
  expect(userB.toArray).toEqual([]);
  await userB.insert({ ...aiDefaults, provider: "gemini", model: "user-b-model" }).when("settled");
  await Promise.all([userA.cleanup(), userB.cleanup()]);
  const restoredA = createAiPreferences("user-a", storage);
  const restoredB = createAiPreferences("user-b", storage);
  expect(await restoredA.toArrayWhenReady()).toMatchObject([
    { provider: "openai", model: "user-a-model" },
  ]);
  expect(await restoredB.toArrayWhenReady()).toMatchObject([
    { provider: "gemini", model: "user-b-model" },
  ]);
  await Promise.all([restoredA.cleanup(), restoredB.cleanup()]);
});
