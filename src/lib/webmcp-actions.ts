import { z } from "zod";

import { createActionRegistry, cureActions } from "@/src/lib/action-registry";
import type { ActionContext } from "@/src/lib/action-registry";
import type { WebMcpTool } from "@/src/lib/webmcp";

// WebMCP tool names avoid dots to stay within common agent name patterns.
export function webmcpToolName(actionId: string) {
  return actionId.replaceAll(".", "_");
}

// Read actions only: write and destructive actions require the in-page
// confirmation flow and stay unavailable to browser agents for now.
export function buildWebMcpTools(
  getContext: () => ActionContext,
  actor: { userId: string },
  registry: ReturnType<typeof createActionRegistry> = createActionRegistry(),
): WebMcpTool[] {
  return registry
    .list()
    .filter(({ kind }) => kind === "read")
    .map(({ id, description }) => {
      const action = cureActions.find((candidate) => candidate.id === id)!;
      return {
        name: webmcpToolName(id),
        description,
        inputSchema: z.toJSONSchema(action.input) as Record<string, unknown>,
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: (input: unknown) =>
          registry.run(
            getContext(),
            { kind: "assistant", interface: "webmcp", userId: actor.userId },
            id,
            input,
          ),
      };
    });
}
