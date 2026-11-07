import { createFileRoute, redirect } from "@tanstack/react-router";

import { deviceHomeRoutes } from "@/src/lib/device";
import { getRequestDevice } from "@/src/lib/request-device";

export const Route = createFileRoute("/")({
  beforeLoad: ({ context }) => {
    // Keep the build-time PWA shell anonymous. Offline bootstrap resolves the
    // device locally and runs the same route redirect without a server request.
    if (context.isShell()) return;
    throw redirect({ to: deviceHomeRoutes[getRequestDevice()], replace: true });
  },
});
