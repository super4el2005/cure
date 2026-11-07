import { describe, expect, it } from "@rstest/core";

import { observeRequest } from "@/src/observability/server";

describe("central request recovery", () => {
  it("converts an unhandled failure into a private safe response with a correlation ID", async () => {
    const response = await observeRequest(
      new Request("https://host/api/ai/chat?token=SECRET"),
      () => {
        throw new Error("SECRET patient message");
      },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
  it("preserves immutable response bodies and cookies", async () => {
    const response = await observeRequest(new Request("https://host/api/ai/chat"), () =>
      Response.json(
        { error: "AI_UNAVAILABLE" },
        { status: 503, headers: { "set-cookie": "test=value; HttpOnly" } },
      ),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await response.json()).toEqual({ error: "AI_UNAVAILABLE" });
  });
});
