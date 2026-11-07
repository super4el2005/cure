import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test } from "@playwright/test";

test("manifest and anonymous shell are served; online pages retain SSR", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  const response = await request.get("/d", { headers: { "accept-language": "en-US,en;q=0.9" } });
  expect(response.ok()).toBeTruthy();
  expect(await response.text()).toContain("Hello, world!");
  const shell = await request.get("/_shell.html");
  expect(shell.ok()).toBeTruthy();
  const html = await shell.text();
  expect(html).not.toContain("session_token");
  expect(html).not.toContain("GOOGLE_CLIENT_SECRET");
});

for (const device of ["desktop", "mobile"] as const) {
  const userAgent =
    device === "mobile"
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
  const homeURL = `http://localhost:3102/${device === "mobile" ? "m" : "d"}`;
  test(`installed worker boots offline after a browser restart and retains local TanStack DB data (${device})`, async () => {
    const profile = await mkdtemp(join(tmpdir(), "cure-pwa-"));
    let context = await chromium.launchPersistentContext(profile, {
      headless: true,
      userAgent,
      locale: "en-US",
    });
    try {
      await context.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
      let page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://localhost:3102/");
      await expect(page.getByRole("heading", { name: "Hello, world!" })).toBeVisible();
      await expect(page.locator("main")).toHaveAttribute("data-page", device);
      await expect(page).toHaveURL(homeURL);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise<void>((resolve) =>
            navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
              once: true,
            }),
          );
        }
      });
      await expect(page.getByText("The app is ready to open offline.")).toBeVisible();
      expect(errors, "initial online hydration").toEqual([]);
      await context.route("**/api/medical/search", (route) =>
        route.fulfill({
          json: {
            source: "ror",
            records: [
              {
                id: "ror:offline-fixture",
                source: "ror",
                sourceId: "offline-fixture",
                title: "Offline Medical University",
                description: "Reference fixture",
                code: "",
                url: "https://ror.org/fixture",
                dataLanguage: "en",
                version: "2026",
                fetchedAt: "2026-11-07T00:00:00Z",
                country: "GB",
                latitude: null,
                longitude: null,
              },
            ],
            total: 1,
            truncated: false,
            fetchedAt: "2026-11-07T00:00:00Z",
            dataLanguage: "en",
          },
        }),
      );
      const catalog = page.getByRole("region", { name: "Medical catalogs" });
      await catalog.getByLabel("Name, term or code").fill("medical AND university");
      await catalog.getByRole("button", { name: "Search source" }).click();
      await expect(
        catalog.getByText("Downloaded records have been saved on this device."),
      ).toBeVisible();
      // A source's semantic query need not be a literal substring of its result titles.
      await expect(catalog.getByText("Offline Medical University", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Add 1 to 0?" }).click();
      await expect(page.getByRole("button", { name: "Add 1 to 1?" })).toBeVisible();
      await context.setOffline(true);
      await page.reload();
      await expect(page.locator("main")).toHaveAttribute("data-page", device);
      await expect(page.getByRole("button", { name: "Add 1 to 1?" })).toBeVisible();
      expect(errors, "offline reload hydration").toEqual([]);
      await page.getByRole("button", { name: "Add 1 to 1?" }).click();
      await expect(page.getByRole("button", { name: "Add 1 to 2?" })).toBeVisible();
      await page.getByRole("button", { name: "Русский", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Привет, мир!" })).toBeVisible();
      await expect(page).toHaveURL(homeURL);
      await page.getByRole("button", { name: "English", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Hello, world!" })).toBeVisible();
      await context.close();

      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        offline: true,
        userAgent,
        locale: "en-US",
      });
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://localhost:3102/");
      await expect(page.getByRole("heading", { name: "Hello, world!" })).toBeVisible();
      await expect(page.locator("main")).toHaveAttribute("data-page", device);
      await expect(page.getByRole("button", { name: "Add 1 to 2?" })).toBeVisible();
      await expect(page).toHaveURL(homeURL);
      // A prefixed route also boots directly from the anonymous shell offline.
      await page.goto(homeURL);
      await expect(page.locator("main")).toHaveAttribute("data-page", device);
      await expect(
        page.getByText("Your session will be checked when you reconnect."),
      ).toBeVisible();
      const restoredCatalog = page.getByRole("region", { name: "Medical catalogs" });
      await expect(
        restoredCatalog.getByText("Offline Medical University", { exact: true }),
      ).toBeVisible();
      await restoredCatalog.getByLabel("Name, term or code").fill("medical");
      await expect(
        restoredCatalog.getByText("Offline Medical University", { exact: true }),
      ).toBeVisible();
      await expect(restoredCatalog.getByRole("button", { name: "Search source" })).toBeDisabled();
      await expect(
        restoredCatalog.getByRole("link", { name: "Research Organization Registry" }),
      ).toBeVisible();
      expect(errors, "offline restart hydration").toEqual([]);
      await page.goto("http://localhost:3102/auth/error");
      await expect(page.getByRole("heading", { name: "Unable to sign in" })).toBeVisible();
      const cachedURLs = await page.evaluate(async () => {
        const urls: string[] = [];
        for (const key of await caches.keys()) {
          for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
        }
        return urls;
      });
      expect(cachedURLs.some((url) => url.includes("/api/auth/"))).toBe(false);
      expect(cachedURLs.some((url) => url.includes("/api/medical/"))).toBe(false);
      expect(cachedURLs.some((url) => url.includes("/_serverFn/"))).toBe(false);
      expect(errors).toEqual([]);
      await context.setOffline(false);
      await page.goto("http://localhost:3102/");
      await page.getByRole("button", { name: "Русский", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Привет, мир!" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Привет, мир!" })).toBeVisible();
      await expect(page).toHaveURL(homeURL);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
