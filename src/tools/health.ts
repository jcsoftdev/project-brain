import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EMBEDDING_MODEL, VERSION } from "../constants.js";
import type { ToolDeps } from "../types.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

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
  server.tool(
    "check_health",
    "Check project brain health status",
    {
      project: z.string().describe("Project identifier"),
    },
    async (args) => handleHealth(args, deps)
  );
}
