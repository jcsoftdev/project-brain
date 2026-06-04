import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Handle delete_knowledge logic (exported for testing). */
export async function handleForget(
  args: { project: string; source: string },
  deps: ToolDeps
): Promise<ToolResult> {
  await deps.store.deleteBySource(args.project, args.source);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ source: args.source, status: "deleted" }),
      },
    ],
  };
}

/** Register delete_knowledge tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "delete_knowledge",
    {
      description: "Remove all chunks from a given source (e.g. a deleted or renamed file) to keep the index accurate.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        source: z.string().describe("Source file or identifier to delete"),
      },
    },
    async (args) => handleForget(args, deps)
  );
}
