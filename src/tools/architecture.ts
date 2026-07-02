import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { toolAnnotations } from "../constants.js";
import { jsonResult, type ToolResult } from "./format.js";

/** Error result when the server has no project root configured (no local repo to inspect). */
function projectRootUnavailable(): ToolResult {
  return jsonResult({ error: "server has no project root configured", code: "PROJECT_ROOT_UNAVAILABLE" }, true);
}

/** Handle get_architecture logic (exported for testing). */
export async function handleArchitecture(
  args: { project: string },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.projectRoot) return projectRootUnavailable();
  const { detectStack } = await import("../indexer/stack.js");
  const [stack, modules, chunks] = await Promise.all([
    detectStack(deps.projectRoot),
    deps.store.listModules(args.project),
    deps.store.countChunks(args.project),
  ]);
  const symbols = deps.graph ? deps.graph.countSymbols() : 0;
  return jsonResult({ stack: stack as unknown as Record<string, unknown>, modules, chunks, symbols });
}

/** Register get_architecture tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_architecture",
    {
      description: "One-call project summary: detected tech stack, indexed modules, chunk count, and symbol count. Use to orient before drilling into search_context or the structural tools.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
      },
      outputSchema: {
        stack: z.object({
          languages: z.array(z.string()),
          frameworks: z.array(z.string()),
          packageManager: z.string().nullable(),
          manifest: z.string().nullable(),
        }).passthrough(),
        modules: z.array(z.string()),
        chunks: z.number(),
        symbols: z.number(),
      },
      annotations: toolAnnotations("get_architecture"),
    },
    async (args) => handleArchitecture(args, deps)
  );
}
