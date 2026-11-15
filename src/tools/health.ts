import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EMBEDDING_MODEL, VERSION, toolAnnotations } from "../constants.js";
import type { ToolDeps } from "../types.js";
import { jsonResult, type ToolResult } from "./format.js";
import { readLastError } from "../store/error-state.js";
import { measureEmbedLatency, readManifestChunks, readProjectRulesState } from "../commands/health.js";
import { readSyncStatus } from "../commands/sync-status.js";
import { HOOK_TIMEOUT_MS } from "../commands/search.js";
import { probeReranker } from "../rerank/probe.js";
import type { InstalledVersionProbe } from "../server/supervisor-version.js";

/** Handle check_health logic (exported for testing). */
export async function handleHealth(
  args: { project: string },
  deps: ToolDeps,
  installedVersion?: InstalledVersionProbe
): Promise<ToolResult> {
  const emb = deps.embeddingsFor ? await deps.embeddingsFor(args.project) : deps.embeddings;

  const [embeddingsAvailable, chunks, lastError, embedLatencyMs, rerankerProbe, manifestChunks, lastSync, projectRules, interactiveLane, installed] =
    await Promise.all([
      emb.isAvailable(),
      deps.store.countChunks(args.project),
      deps.dbPath ? readLastError(deps.dbPath, args.project) : Promise.resolve(null),
      measureEmbedLatency(emb),
      probeReranker(deps.reranker),
      deps.projectRoot ? readManifestChunks(deps.projectRoot) : Promise.resolve(undefined),
      deps.projectRoot ? readSyncStatus(deps.projectRoot) : Promise.resolve(null),
      deps.projectRoot ? readProjectRulesState(deps.projectRoot) : Promise.resolve(undefined),
      deps.probeInteractiveLane ? deps.probeInteractiveLane(emb.model ?? EMBEDDING_MODEL) : Promise.resolve(undefined),
      installedVersion ? installedVersion().catch(() => null) : Promise.resolve(null),
    ]);

  const report = {
    store: "connected",
    embeddings: embeddingsAvailable ? "available" : "unavailable",
    model: emb.model ?? EMBEDDING_MODEL,
    chunks,
    version: VERSION,
    ...(installed ?? {}),
    // `deps.reranker` is only ever set when a token resolved at startup
    // (see createServer) — its presence IS "on", no separate lookup.
    reranker: deps.reranker ? "on" : "off",
    ...(deps.rerankerTokenSource ? { tokenSource: deps.rerankerTokenSource } : {}),
    ...(deps.rerankerTokenPath ? { tokenPath: deps.rerankerTokenPath } : {}),
    rerankerProbe,
    ...(lastError ? { lastError } : {}),
    ...(embedLatencyMs !== undefined ? { embedLatencyMs } : {}),
    slowEmbeddings: embedLatencyMs !== undefined && embedLatencyMs > HOOK_TIMEOUT_MS,
    ...(manifestChunks !== undefined
      ? { manifestChunks, desynced: chunks < manifestChunks }
      : {}),
    ...(lastSync ? { lastSync } : {}),
    ...(projectRules !== undefined ? { projectRules } : {}),
    ...(interactiveLane ? { interactiveLane } : {}),
  };

  return jsonResult(report);
}

/** Register check_health tool with MCP server. */
export function register(server: McpServer, deps: ToolDeps, installedVersion?: InstalledVersionProbe): void {
  server.registerTool(
    "check_health",
    {
      description: "Check embedding service + index status. Run when search_context returns empty/weak results to diagnose a down Ollama or stale/missing index.",
      inputSchema: {
        project: z.string().describe("Project identifier"),
      },
      outputSchema: {
        store: z.string(),
        embeddings: z.string(),
        model: z.string(),
        chunks: z.number(),
        version: z.string(),
        installedVersion: z.string().optional(),
        versionDrift: z.string().optional(),
        reranker: z.enum(["off", "on"]),
        tokenSource: z.enum(["env", "file"]).optional(),
        tokenPath: z.string().optional(),
        rerankerProbe: z.object({
          status: z.enum(["reachable", "degraded", "not-configured"]),
          latencyMs: z.number().optional(),
          reason: z.string().optional(),
        }),
        lastError: z
          .object({ phase: z.string(), message: z.string(), timestamp: z.number() })
          .optional(),
        embedLatencyMs: z.number().optional(),
        slowEmbeddings: z.boolean(),
        manifestChunks: z.number().optional(),
        desynced: z.boolean().optional(),
        lastSync: z
          .object({
            outcome: z.enum(["running", "ok", "aborted", "failed", "crashed"]),
            pid: z.number(),
            startedAt: z.number(),
            changedOnly: z.boolean(),
            trigger: z.string().optional(),
            finishedAt: z.number().optional(),
            files: z.number().optional(),
            chunks: z.number().optional(),
            error: z.string().optional(),
          })
          .optional(),
        projectRules: z.enum(["current", "stale", "missing"]).optional(),
        interactiveLane: z
          .object({
            status: z.enum(["off", "up", "down", "mismatch"]),
            host: z.string().optional(),
            reason: z.string().optional(),
          })
          .optional(),
      },
      annotations: toolAnnotations("check_health"),
    },
    async (args) => handleHealth(args, deps, installedVersion)
  );
}
