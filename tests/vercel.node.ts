import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Exercise the deployment entry in Node, with the real built Rspack chunks.
// No HTTP server is started and no external service is contacted.
const entryUrl = pathToFileURL(resolve("api/index.ts")).href;
const { default: app } = (await import(entryUrl)) as {
  default: { fetch(request: Request): Promise<Response> };
};

const nativeFetch = globalThis.fetch;

function signInRequest() {
  return new Request("https://cure-avx3.vercel.app/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google" }),
  });
}

test("forwards an immutable fetch response without throwing", async (t) => {
  const payload = { url: "https://accounts.google.com/", redirect: true };
  // Native fetch produces immutable response headers, unlike new Response().
  const upstream = await nativeFetch(
    `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`,
  );
  assert.throws(() => upstream.headers.set("test", "value"), TypeError);
  t.mock.method(globalThis, "fetch", async () => upstream);
  t.after(() => t.mock.restoreAll());

  const response = await app.fetch(signInRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), payload);
});

test("preserves redirect, multiple cookies and the upstream stream", async (t) => {
  const cookies = [
    "oauth-state=first; Path=/; HttpOnly; Secure; SameSite=Lax",
    "session=second; Path=/; HttpOnly; Secure; SameSite=Lax",
  ];
  const upstream = new Response("redirect body", {
    status: 302,
    statusText: "Found",
    headers: [
      ["location", "https://accounts.google.com/"],
      ...cookies.map((cookie): [string, string] => ["set-cookie", cookie]),
    ],
  });
  t.mock.method(globalThis, "fetch", async () => upstream);
  t.after(() => t.mock.restoreAll());

  const response = await app.fetch(signInRequest());
  assert.equal(response.status, 302);
  assert.equal(response.statusText, "Found");
  assert.equal(response.headers.get("location"), "https://accounts.google.com/");
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.body, upstream.body);
  assert.equal(await response.text(), "redirect body");
});

test("root routing selects /d or /m from request signals and preserves SSR locale", async () => {
  for (const [userAgent, mobileHint, device] of [
    ["Windows NT 10.0; Win64; x64", "?0", "desktop"],
    ["iPhone; CPU iPhone OS 18_0 like Mac OS X", "?1", "mobile"],
    ["iPad; CPU OS 18_0 like Mac OS X", "?0", "mobile"],
    ["Macintosh; Intel Mac OS X 10_15_7", "?0", "desktop"],
  ] as const) {
    const headers = {
      "user-agent": userAgent,
      "sec-ch-ua-mobile": mobileHint,
      "accept-language": "en-US,en;q=0.9",
    };
    const redirect = await app.fetch(new Request("https://cure-sooty.vercel.app/", { headers }));
    assert.equal(redirect.status, 307);
    const target = new URL(redirect.headers.get("location")!, "https://cure-sooty.vercel.app");
    assert.equal(target.pathname, device === "mobile" ? "/m" : "/d");
    assert.equal(redirect.headers.get("cache-control"), "private, no-store");
    const response = await app.fetch(new Request(target, { headers }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("vary") ?? "", /User-Agent/i);
    assert.match(response.headers.get("vary") ?? "", /Sec-CH-UA-Mobile/i);
    const html = await response.text();
    assert.match(html, new RegExp(`data-device="${device}"`));
    assert.match(html, new RegExp(`data-page="${device}"`));
    assert.doesNotMatch(
      html,
      new RegExp(`data-page="${device === "mobile" ? "desktop" : "mobile"}"`),
    );
    assert.match(html, /Doctors and researchers — together/);
  }
});

test("prerendered offline shell contains no device-specific page", () => {
  const html = readFileSync("dist/client/_shell.html", "utf8");
  assert.match(html, /data-offline-shell="true"/);
  assert.doesNotMatch(html, /data-device="(?:desktop|mobile)"/);
  assert.doesNotMatch(html, /data-page="(?:desktop|mobile)"/);
});

test("SSR negotiates language from request headers and cookies, independently of query", async () => {
  for (const [acceptLanguage, cookie, expected, query] of [
    ["en-US,en;q=0.9", "", "en", ""],
    ["ru-RU,ru;q=0.9", "", "ru", ""],
    ["ru;q=0.2,en;q=0.9", "", "en", ""],
    ["en-US", "cure.locale=ru", "ru", ""],
    ["ru-RU", "cure.locale=en", "en", ""],
    ["en-US", "cure.locale=invalid", "en", ""],
    ["de-DE", "", "ru", ""],
    ["", "", "ru", ""],
    ["ru-RU", "", "ru", "?lang=en"],
  ] as const) {
    const response = await app.fetch(
      new Request(`https://cure-sooty.vercel.app/d${query}`, {
        headers: { "accept-language": acceptLanguage, cookie },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-language"), expected);
    assert.match(response.headers.get("vary") ?? "", /Accept-Language/i);
    assert.match(response.headers.get("vary") ?? "", /Cookie/i);
    const html = await response.text();
    assert.match(html, new RegExp(`<html[^>]*lang="${expected}"`));
    assert.match(
      html,
      expected === "en" ? /Doctors and researchers — together/ : /Врачи и исследователи — вместе/,
    );
    assert.doesNotMatch(html, /href="[^"]*[?&]lang=/);
  }
});

test("AI endpoint is routed through Start and rejects foreign origins without provider calls", async () => {
  const response = await app.fetch(
    new Request("https://cure-sooty.vercel.app/api/ai/chat", {
      method: "POST",
      headers: { origin: "https://other.example", "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "FORBIDDEN_ORIGIN" });
});

test("routes the medical gateway in the production bundle without contacting external services", async () => {
  const response = await app.fetch(
    new Request("https://cure.example/api/medical/search", {
      method: "POST",
      headers: { origin: "https://cure.example", "content-type": "application/json" },
      body: JSON.stringify({ source: "invalid", query: "medical" }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "INVALID_SEARCH" });
});

test("desktop and mobile pages are selected by their routes, independently of request device", async () => {
  for (const [path, device, userAgent] of [
    ["/d", "desktop", "iPhone"],
    ["/m", "mobile", "Windows NT 10.0"],
  ] as const) {
    const response = await app.fetch(
      new Request(`https://cure-sooty.vercel.app${path}`, {
        headers: { "user-agent": userAgent, "accept-language": "en-US" },
      }),
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-page="${device}"`));
    assert.doesNotMatch(
      html,
      new RegExp(`data-page="${device === "mobile" ? "desktop" : "mobile"}"`),
    );
  }
});

test("request observation adds correlation IDs and preserves safe API errors", async () => {
  const response = await app.fetch(
    new Request("https://cure-sooty.vercel.app/api/medical/search", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://cure-sooty.vercel.app" },
      body: JSON.stringify({ source: "icd10", query: "" }),
    }),
  );
  assert.equal(response.status, 400);
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "INVALID_SEARCH" });
});

test("public directories and protected entry pages render without patient data or live backend calls", async () => {
  for (const base of ["/d", "/m"]) {
    for (const [path, heading] of [
      ["/specialists", "Specialists"],
      ["/organizations", "Organizations"],
      ["/profile", "My professional profile"],
      ["/patients", "Patients"],
    ]) {
      const response = await app.fetch(
        new Request(`https://cure-sooty.vercel.app${base}${path}`, {
          headers: { "accept-language": "en" },
        }),
      );
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(heading!));
      assert.ok(html.includes(`${base}/profile`));
      assert.doesNotMatch(html, /Private patient|Private clinical notes/);
    }
  }
});

test("offline shell precaches the SQLite worker and WASM runtime", () => {
  const worker = readFileSync("dist/client/sw.js", "utf8");
  assert.match(worker, /opfs-worker[^"\s]*\.js/);
  assert.match(worker, /\.wasm/);
});

test("research detail and project workspace are independent desktop/mobile routes", async () => {
  for (const device of ["d", "m"]) {
    const headers = { "accept-language": "en-US,en;q=0.9" };
    const detail = await app.fetch(
      new Request(
        `https://cure-sooty.vercel.app/${device}/research/8df7de54-a59e-41fd-8a44-480b44a12f0c`,
        { headers },
      ),
    );
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /All studies/);
    assert.doesNotMatch(html, /Search downloaded studies/);
    const workspace = await app.fetch(
      new Request(`https://cure-sooty.vercel.app/${device}/projects`, { headers }),
    );
    assert.equal(workspace.status, 200);
    assert.match(await workspace.text(), /Private projects, study stages/);
  }
});

test("public specialist and organization detail routes do not render directory parents", async () => {
  for (const device of ["d", "m"]) {
    for (const [section, title, directoryText] of [
      ["specialists", "Specialist profile", "Search"],
      ["organizations", "Organization page", "open to collaboration"],
    ] as const) {
      const response = await app.fetch(
        new Request(`https://cure-sooty.vercel.app/${device}/${section}/unknown`, {
          headers: { "accept-language": "en" },
        }),
      );
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(title));
      assert.doesNotMatch(html, new RegExp(directoryText));
    }
  }
});

test("protocol pages render their own protected entry without the project list parent", async () => {
  for (const device of ["d", "m"]) {
    const response = await app.fetch(
      new Request(
        `https://cure-sooty.vercel.app/${device}/projects/8df7de54-a59e-41fd-8a44-480b44a12f0c/protocol`,
        { headers: { "accept-language": "en" } },
      ),
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Study protocol/);
    assert.doesNotMatch(html, /Private projects, study stages/);
  }
});
