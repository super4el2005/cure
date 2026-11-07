import { describe, expect, it } from "@rstest/core";

import { detectDevice, resolveClientDevice } from "@/src/lib/device";

describe("device selection", () => {
  it.each([
    ["Windows NT 10.0; Win64; x64", undefined, "desktop"],
    ["Macintosh; Intel Mac OS X 10_15_7", undefined, "desktop"],
    ["iPhone; CPU iPhone OS 18_0 like Mac OS X", undefined, "mobile"],
    ["Linux; Android 15; Pixel 9 Mobile", undefined, "mobile"],
    ["iPad; CPU OS 18_0 like Mac OS X", "?0", "mobile"],
    ["Linux; Android 15; Tablet", "?0", "mobile"],
    ["Unknown client", "?1", "mobile"],
    ["Unknown client", "?0", "desktop"],
    ["", undefined, "desktop"],
    ["", "?1", "mobile"],
    ["Unknown client", undefined, "desktop"],
    [
      "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      "?0",
      "mobile",
    ],
    [
      "Mozilla/5.0 (Linux; U; en-US; KFAPWI Build/JDQ39) AppleWebKit/535.19 (KHTML, like Gecko) Silk/3.13 Safari/535.19 Silk-Accelerated=true",
      "?0",
      "mobile",
    ],
    ["iPhone; CPU iPhone OS 18_0 like Mac OS X", "?0", "desktop"],
  ])("selects %s / %s as %s", (userAgent, mobileHint, expected) => {
    expect(detectDevice({ userAgent, mobileHint })).toBe(expected);
  });

  it("keeps the serialized server choice for hydration and client navigation", () => {
    expect(resolveClientDevice("desktop", { userAgent: "iPhone" })).toBe("desktop");
    expect(resolveClientDevice("mobile", { userAgent: "Windows NT" })).toBe("mobile");
  });

  it("selects locally when the anonymous offline shell has no device choice", () => {
    expect(resolveClientDevice(undefined, { userAgent: "iPhone" })).toBe("mobile");
    expect(resolveClientDevice(undefined, { userAgent: "Windows NT" })).toBe("desktop");
  });
});
