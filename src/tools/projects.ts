import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { toolAnnotations } from "../constants.js";
import { jsonResult, type ToolResult } from "./format.js";

/** Error result when the wired store doesn't implement the optional admin methods. */
function adminUnsupported(): ToolResult {
  return jsonResult({ error: "store does not support this admin operation", code: "ADMIN_UNSUPPORTED" }, true);
}

/** Handle list_projects logic (exported for testing). */
export async function handleListProjects(
  _args: Record<string, never>,
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.store.listProjects) return adminUnsupported();
  const projects = await deps.store.listProjects();
  return jsonResult({ projects });
}

/** Handle delete_project logic (exported for testing). */
export async function handleDeleteProject(
  args: { project: string },
  deps: ToolDeps
): Promise<ToolResult> {
  if (!deps.store.deleteProject) return adminUnsupported();
  if (deps.confirmDestructive) {
    const chunks = await deps.store.countChunks(args.project);
    const ok = await deps.confirmDestructive(
      `Delete project "${args.project}" (${chunks} chunks)? This removes the vector index + metadata only — the project's own .project-brain/ directory is not touched.`
    );
    if (!ok) return jsonResult({ project: args.project, status: "cancelled" });
  }
  const deleted = await deps.store.deleteProject(args.project);
  return jsonResult({ project: args.project, status: deleted ? "deleted" : "not_found" });
}

/** Register list_projects and delete_project tools with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_projects",
    {
      description: "List every indexed project with its chunk count and embedding meta (model/dim). Use to orient before delete_project or to audit what's indexed. Project identifiers are returned in sanitized form (e.g. project-brain → project_brain); pass them back verbatim to other tools.",
      inputSchema: {},
      outputSchema: {
        projects: z.array(z.object({
          project: z.string(),
          chunks: z.number(),
          model: z.string().optional(),
          dim: z.number().optional(),
        })),
      },
      annotations: toolAnnotations("list_projects"),
    },
    async (args) => handleListProjects(args, deps)
  );

  server.registerTool(
    "delete_project",
    {
      description: "Delete an entire indexed project. Removes the vector index + metadata only — never touches the project's own .project-brain/ directory.",
      inputSchema: {
        project: z.string().describe("Project identifier to delete"),
      },
      outputSchema: { project: z.string(), status: z.string() },
      annotations: toolAnnotations("delete_project"),
    },
    async (args) => handleDeleteProject(args, deps)
  );
}
