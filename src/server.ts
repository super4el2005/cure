import "@/src/observability/server";
import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

import { observeRequest } from "@/src/observability/server";

export default createServerEntry(
  wrapFetchWithSentry({
    fetch: (request: Request) => observeRequest(request, async () => handler.fetch(request)),
  }),
);
