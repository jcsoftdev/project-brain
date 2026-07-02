import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "../types.js";
import { jsonResult, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import type { SyncProgress } from "../commands/sync.js";

type RunSyncFn = typeof import("../commands/sync.js").runSync;

/** Error result when the server has no project root configured (no local repo to sync). */
function projectRootUnavailable(): ToolResult {
  return jsonResult({ error: "server has no project root configured", code: "PROJECT_ROOT_UNAVAILABLE" }, true);
}

/**
 * Handle sync_project logic (exported for testing).
 *
 * extra is the SDK RequestHandlerExtra — typed loosely so tests can stub it.
 * Verified against the installed SDK (@modelcontextprotocol/sdk 1.29.0,
 * dist/esm/shared/protocol.d.ts:189/207): tool callbacks receive
 * `extra._meta?.progressToken` and `extra.sendNotification`.
 */
export async function handleSyncProject(
  args: { project: string },
  deps: ToolDeps,
  extra?: { _meta?: { progressToken?: string | number }; sendNotification?: (n: unknown) => Promise<void> },
  runSyncImpl?: RunSyncFn
): Promise<ToolResult> {
  if (!deps.projectRoot) return projectRootUnavailable();

  const runSync = runSyncImpl ?? (await import("../commands/sync.js")).runSync;
  const token = extra?._meta?.progressToken;
  const onProgress = token !== undefined && extra?.sendNotification
    ? (p: SyncProgress) => {
        void extra.sendNotification!({
          method: "notifications/progress",
          params: { progressToken: token, progress: p.current, total: p.total, message: p.phase },
        });
      }
    : undefined;

  const emb = deps.embeddingsFor ? await deps.embeddingsFor(args.project) : deps.embeddings;
  const result = await runSync({
    root: deps.projectRoot,
    projectId: args.project,
    store: deps.store,
    embeddings: emb,
    graph: deps.graph,          // injected → ownsGraph=false → worker pool stays off in serve
    changedFiles: [],           // full walk, hash-gated (fast when warm)
    onProgress,
  });
  return jsonResult({ ...result });
}

/** Register sync_project tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "sync_project",
    {
      description: "Re-index changed files now (incremental, hash-gated). Streams progress when the client provides a progressToken. Can take minutes on a large cold repo.",
      inputSchema: { project: z.string().describe("Project identifier") },
      outputSchema: {
        ingested: z.number(),
        skipped: z.number(),
        deleted: z.number(),
        scanned: z.number(),
        embedFailed: z.number(),
        error: z.string().optional(),
      },
      annotations: toolAnnotations("sync_project"),
    },
    async (args, extra) => handleSyncProject(args, deps, extra as any)
  );
}
