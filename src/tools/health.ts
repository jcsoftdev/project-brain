import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EMBEDDING_MODEL, VERSION, toolAnnotations } from "../constants.js";
import type { ToolDeps } from "../types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Handle check_health logic (exported for testing). */
export async function handleHealth(
  args: { project: string },
  deps: ToolDeps
): Promise<ToolResult> {
  const [embeddingsAvailable, chunks] = await Promise.all([
    deps.embeddings.isAvailable(),
    deps.store.countChunks(args.project),
  ]);

  const report = {
    store: "connected",
    embeddings: embeddingsAvailable ? "available" : "unavailable",
    model: EMBEDDING_MODEL,
    chunks,
    version: VERSION,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(report) }],
  };
}

/** Register check_health tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "check_health",
    {
      description: "Check embedding service + index status. Run when search_context returns empty/weak results to diagnose a down Ollama or stale/missing index.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
      },
      annotations: toolAnnotations("check_health"),
    },
    async (args) => handleHealth(args, deps)
  );
}
