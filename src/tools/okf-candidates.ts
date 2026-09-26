import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SpawnFn } from "../bench/mine.js";
import type { ToolDeps } from "../types.js";
import { jsonResult, graphUnavailable, type ToolResult } from "./format.js";
import { toolAnnotations } from "../constants.js";
import { mineOkfCandidates } from "../okf/candidates.js";
import { readBundle } from "../okf/bundle.js";
import { DEFAULT_OKF_DIR } from "../okf/route.js";

export interface OkfCandidatesArgs {
  /** Target another indexed project by id. okf_candidates only supports the server's own project. */
  project?: string;
  dir?: string;
  since?: string;
  limit?: number;
}

export interface OkfCandidatesIo {
  spawn?: SpawnFn;
  resolveToken?: () => Promise<string | null>;
}

/**
 * `okf_candidates` — same data `project-brain okf candidates` prints, as
 * structured JSON for an agent to act on directly.
 *
 * Deliberately single-project: mining reads git history and the filesystem
 * under `deps.projectRoot`, and there is no per-project root registry the way
 * there is a per-project graph registry (`deps.graphFor`) — a mismatched
 * `project` is refused rather than silently mined against the wrong repo.
 */
export async function handleOkfCandidates(args: OkfCandidatesArgs, deps: ToolDeps, io: OkfCandidatesIo = {}): Promise<ToolResult> {
  if (args.project && deps.projectId && args.project !== deps.projectId) {
    return jsonResult(
      {
        error: `okf_candidates only supports the server's own project ("${deps.projectId}"); got "${args.project}"`,
        code: "PROJECT_MISMATCH",
      },
      true
    );
  }
  if (!deps.graph) return graphUnavailable();
  if (!deps.projectRoot) {
    return jsonResult({ error: "project root unavailable", code: "PROJECT_ROOT_UNAVAILABLE" }, true);
  }

  const dir = join(deps.projectRoot, args.dir ?? DEFAULT_OKF_DIR);
  let bundle: Awaited<ReturnType<typeof readBundle>> | undefined;
  if (existsSync(dir)) {
    try {
      bundle = await readBundle(dir);
    } catch {
      bundle = undefined;
    }
  }

  const resolveToken = io.resolveToken ?? (await import("../rerank/token.js")).resolveRerankerToken;
  const token = await resolveToken();

  const result = await mineOkfCandidates({
    cwd: deps.projectRoot,
    spawn: io.spawn,
    graph: deps.graph,
    token,
    since: args.since,
    topN: args.limit,
    bundle,
    bundleLayout: bundle ? { bundleRoot: dir, repoRoot: deps.projectRoot } : undefined,
  });

  return jsonResult({ ...result, project: deps.projectId ?? "unknown" });
}

const ANCHOR_OUTPUT = { proposed: z.string(), path: z.string(), symbol: z.string().nullable(), resolved: z.boolean() };
const SCORE_OUTPUT = z
  .object({
    surprising: z.number().nullable(),
    constraint: z.number().nullable(),
    rejectedAlternative: z.number().nullable(),
    worthiness: z.number().nullable(),
  })
  .nullable();

export function register(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "okf_candidates",
    {
      description:
        "Mine \"fix:\" commits from git history and rank them as possible Open Knowledge Format concepts. " +
        "Scores each with Jev (surprising cause, rejected alternative, non-local constraint, overall worthiness) " +
        "when a TypeSafe token is configured; falls back to a heuristic ranking otherwise. Proposes an anchor " +
        "(the most-changed symbol) and reports whether it resolves. Skips commits an existing concept already covers.",
      inputSchema: {
        project: z.string().optional().describe("Must match the server's own project id, if given."),
        dir: z.string().optional().describe("Bundle directory, relative to the project root. Defaults to okf."),
        since: z.string().optional().describe("Only commits after this rev or date."),
        limit: z.number().optional().describe("How many ranked candidates to return. Default 20."),
      },
      outputSchema: {
        project: z.string().optional(),
        heuristic: z.boolean().optional(),
        notice: z.string().optional(),
        scanned: z.number().optional(),
        candidates: z
          .array(
            z.object({
              hash: z.string(),
              subject: z.string(),
              rank: z.number(),
              scores: SCORE_OUTPUT,
              anchor: z.object(ANCHOR_OUTPUT),
            })
          )
          .optional(),
        error: z.string().optional(),
        code: z.string().optional(),
      },
      annotations: toolAnnotations("okf_candidates") ?? { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => handleOkfCandidates(args as OkfCandidatesArgs, deps)
  );
}
