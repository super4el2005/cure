// Thin, guarded adapter over the WebMCP draft API. The entry point moved
// from navigator.modelContext to document.modelContext during the origin
// trial, so both locations are feature-detected. Anything unsupported is
// reported by the return value, never by breaking the page.

export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  execute: (args: unknown) => Promise<unknown>;
};
export type ModelContextLike = {
  registerTool?: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
};

export function browserModelContext(): ModelContextLike | null {
  if (typeof document !== "undefined" && "modelContext" in document)
    return (document as unknown as { modelContext: ModelContextLike }).modelContext;
  if (typeof navigator !== "undefined" && "modelContext" in navigator)
    return (navigator as unknown as { modelContext: ModelContextLike }).modelContext;
  return null;
}

// Registers tools under an abort signal so page teardown unregisters them.
// Individual registration failures (duplicates, schema rejections) must not
// break the app or the remaining tools.
export function registerWebMcpTools(
  tools: readonly WebMcpTool[],
  signal: AbortSignal,
  host: ModelContextLike | null = browserModelContext(),
) {
  if (!host || typeof host.registerTool !== "function") return false;
  for (const tool of tools) {
    try {
      const result = host.registerTool(tool, { signal });
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      // A single rejected tool must not prevent the rest of the registry.
    }
  }
  return true;
}
