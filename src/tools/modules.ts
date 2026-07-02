import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { toolAnnotations } from "../constants.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Handle list_modules logic (exported for testing). */
export async function handleListModules(
  args: { project: string },
  deps: ToolDeps
): Promise<ToolResult> {
  const modules = await deps.store.listModules(args.project);
  return {
    content: [{ type: "text", text: JSON.stringify({ modules }) }],
  };
}

/** Handle get_module logic (exported for testing). */
export async function handleGetModule(
  args: { project: string; module: string },
  deps: ToolDeps
): Promise<ToolResult> {
  const chunks = await deps.store.getModuleChunks(args.project, args.module);
  const result = chunks.map((c) => ({
    id: c.id,
    content: c.content,
    source: c.source,
    module: c.module,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ chunks: result }) }],
  };
}

/** Register list_modules and get_module tools with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_modules",
    {
      description: "List this project's indexed modules. Use to orient before a targeted get_module or search_context.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
      },
      annotations: toolAnnotations("list_modules"),
    },
    async (args) => handleListModules(args, deps)
  );

  server.registerTool(
    "get_module",
    {
      description: "Retrieve all chunks for one known module. Use when you need a full module rather than a semantic slice.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        module: z.string().describe("Module name"),
      },
      annotations: toolAnnotations("get_module"),
    },
    async (args) => handleGetModule(args, deps)
  );
}
