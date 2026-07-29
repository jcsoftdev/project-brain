import { z } from "zod";
import type { GraphStore } from "../graph/store.js";
import type { GraphDeps } from "../types.js";
import { jsonResult, graphUnavailable, type ToolResult } from "./format.js";

/** Reported project id when the server could not determine its own. */
export const UNKNOWN_PROJECT = "unknown";

/** Shared optional `project` input for every structural tool. */
export const PROJECT_ARG = z
  .string()
  .optional()
  .describe(
    "Target another indexed project by id (see list_projects). Omit to query the project this server was started in."
  );

/** Shared optional output fields every structural tool carries. */
export const SCOPE_OUTPUT = {
  project: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
};

export type GraphScope =
  | { ok: true; graph: GraphStore; project: string }
  | { ok: false; result: ToolResult };

/**
 * Pick the graph a structural tool should read, and the project id it is
 * answering for.
 *
 * The semantic tools take a `project` because the vector store is one global
 * multi-project LanceDB. The structural graph is the opposite — a project-LOCAL
 * `<root>/.project-brain/graph.db` — so scoping needs a lookup from project id
 * to filesystem root (see src/store/project-registry.ts), wired in by the
 * server as `deps.graphFor`.
 *
 * Omitting `project` keeps the previous behavior exactly: answer from the
 * server's own graph. The returned `project` is echoed in every structural
 * tool's payload so a caller can never be silently answered from a repository
 * other than the one it meant.
 */
export async function resolveGraphScope(deps: GraphDeps, project?: string): Promise<GraphScope> {
  const own = deps.projectId ?? UNKNOWN_PROJECT;

  if (!project || project === own) {
    if (!deps.graph) return { ok: false, result: graphUnavailable() };
    return { ok: true, graph: deps.graph, project: own };
  }

  const graph = deps.graphFor ? await deps.graphFor(project) : null;
  if (!graph) {
    return {
      ok: false,
      result: jsonResult(
        {
          error:
            `project "${project}" is not registered, or has no structural index yet. ` +
            `Run \`project-brain init\` in that project, then \`project-brain sync\`.`,
          code: "PROJECT_NOT_FOUND",
        },
        true
      ),
    };
  }
  return { ok: true, graph, project };
}
