import Bowser from "bowser";

export type Device = "desktop" | "mobile";

export const deviceHomeRoutes = { desktop: "/d", mobile: "/m" } as const;

type DeviceSignals = {
  userAgent?: string | undefined;
  mobileHint?: string | undefined;
};

// Bowser owns UA parsing. Our routing policy groups phones and tablets into /m;
// Sec-CH-UA-Mobile: ?0 does not exclude tablets.
export function detectDevice({ userAgent = "", mobileHint }: DeviceSignals): Device {
  const platform = userAgent ? Bowser.getParser(userAgent).getPlatformType() : undefined;
  const mobile =
    platform === "tablet" || mobileHint === "?1" || (mobileHint !== "?0" && platform === "mobile");
  return mobile ? "mobile" : "desktop";
}

export function resolveClientDevice(
  serverDevice: string | undefined,
  signals: DeviceSignals,
): Device {
  // Keep the server's choice during hydration and subsequent navigation.
  if (serverDevice === "mobile" || serverDevice === "desktop") return serverDevice;
  return detectDevice(signals);
}
