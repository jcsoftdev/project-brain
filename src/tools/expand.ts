import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";

interface ExpandArgs { project: string; chunk_id: string; }
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; };

export async function handleExpand(args: ExpandArgs, deps: ToolDeps): Promise<ToolResult> {
  const chunk = await deps.store.getChunkById(args.project, args.chunk_id);
  if (!chunk) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "chunk_id not found", code: "CHUNK_NOT_FOUND" }) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({
      chunk_id: chunk.id, source: chunk.source, symbol: chunk.symbol_name,
      start_line: chunk.start_line, end_line: chunk.end_line, content: chunk.content,
    }) }],
  };
}

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "expand_context",
    {
      description: "Get the full body of a chunk_id returned by search_context. Use after search_context to read the exact code you selected instead of re-reading entire files.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        chunk_id: z.string().describe("chunk_id from search_context results"),
      },
    },
    async (args) => handleExpand(args, deps)
  );
}
