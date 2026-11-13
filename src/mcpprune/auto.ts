import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { featureEnabled, featureEnvOptOut } from "../features.js";
import { readRegistry } from "../store/project-registry.js";
import type { TypesafeFetchFn } from "../typesafe/client.js";
import { jevFromProcess } from "./judge.js";
import { applyUnlocked, envFromProcess, planPrune, repoKey, withPruneLock, type ApplyResult, type PruneEnv } from "./prune.js";

export interface AutoPruneOptions {
  /** Directory holding `.claude.json` and `.claude/projects`. Defaults to the home directory. */
  home?: string;
  dataDir: string;
  /** Only the projects of this repo; otherwise every project registered with project-brain. */
  root?: string;
  /** Test seam for the Jev request. */
  fetchFn?: TypesafeFetchFn;
}

export type AutoPruneResult =
  | { ran: false; reason: "off" | "locked" | "nothing to plan" }
  | ({ ran: true } & ApplyResult);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `~/.claude.json` project dirs this run covers: those of `root`'s repo, or every registered one. */
async function scope(home: string, dataDir: string, root?: string): Promise<string[]> {
  let dirs: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(join(home, ".claude.json"), "utf-8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.projects)) dirs = Object.keys(parsed.projects);
  } catch {
    return [];
  }
  if (root !== undefined) {
    const repo = repoKey(root);
    return dirs.filter((d) => d === root || repoKey(d) === repo);
  }
  const registered = new Set(Object.values(await readRegistry(dataDir)).map((e) => e.root));
  return dirs.filter((d) => registered.has(d) || registered.has(repoKey(d)));
}

/**
 * Prune between sessions, without the user running setup: `init` calls it for its own
 * project, the SessionEnd maintenance job for every registered one. It only runs when
 * the opt-in Jev assist is on, a token exists and MCP prune itself is on, so turning
 * the opt-in off leaves both commands doing exactly what they did before. Holds the
 * machine-wide prune lock across plan and apply, and skips when another prune has it.
 * A running session keeps the MCP set it started with; the change reaches the next one.
 * Never throws.
 */
export async function autoPrune(opts: AutoPruneOptions): Promise<AutoPruneResult> {
  try {
    if (featureEnvOptOut("mcp-prune") || !featureEnabled("mcp-prune", opts.dataDir)) return { ran: false, reason: "off" };
    const jev = await jevFromProcess(opts.dataDir);
    if (!jev) return { ran: false, reason: "off" };
    const env: PruneEnv = {
      home: opts.home ?? homedir(),
      dataDir: opts.dataDir,
      ...envFromProcess(),
      jev: opts.fetchFn ? { ...jev, fetchFn: opts.fetchFn } : jev,
      askJev: true,
    };
    const result = await withPruneLock(env, async (): Promise<AutoPruneResult> => {
      const only = await scope(env.home, env.dataDir, opts.root);
      if (only.length === 0) return { ran: false, reason: "nothing to plan" };
      return { ran: true, ...(await applyUnlocked(env, await planPrune(env, only))) };
    });
    return result ?? { ran: false, reason: "locked" };
  } catch (e) {
    return { ran: true, added: [], backup: null, error: e instanceof Error ? e.message : String(e) };
  }
}
