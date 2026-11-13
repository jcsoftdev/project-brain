import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectDirKey } from "../toolcatalog/transcripts.js";
import { featureEnabled, featureEnvOptOut } from "../features.js";
import { readRegistry } from "../store/project-registry.js";
import type { TypesafeFetchFn } from "../typesafe/client.js";
import { jevFromProcess } from "./judge.js";
import { applyUnlocked, envFromProcess, JEV_RUN_DEADLINE_MS, planPrune, repoKey, withPruneLock, type ApplyResult, type PruneEnv } from "./prune.js";

/** A transcript written this recently means Claude Code may still be running there. */
export const LIVE_SESSION_MS = 10 * 60_000;

export interface AutoPruneOptions {
  /** Directory holding `.claude.json` and `.claude/projects`. Defaults to the home directory. */
  home?: string;
  dataDir: string;
  /** Only this project directory; otherwise every project registered with project-brain. */
  root?: string;
  /** Test seam for the Jev request. */
  fetchFn?: TypesafeFetchFn;
}

export type AutoPruneResult =
  | { ran: false; reason: "off" | "locked" | "nothing to plan" }
  | ({ ran: true } & ApplyResult);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True when a session in `dir` wrote its transcript within {@link LIVE_SESSION_MS}. A live
 * Claude Code process can rewrite `~/.claude.json` from memory, which would silently undo the
 * prune and then read as the user re-enabling the server.
 */
async function hasLiveSession(home: string, dir: string, now: number): Promise<boolean> {
  const tdir = join(home, ".claude", "projects", projectDirKey(dir));
  const names = await readdir(tdir).catch(() => [] as string[]);
  for (const n of names.filter((n) => n.endsWith(".jsonl"))) {
    const mtime = await stat(join(tdir, n)).then((s) => s.mtimeMs, () => 0);
    if (now - mtime < LIVE_SESSION_MS) return true;
  }
  return false;
}

/** The `~/.claude.json` project dirs this run covers: `root` alone, or every registered one; never one with a live session. */
async function scope(home: string, dataDir: string, root?: string): Promise<string[]> {
  let dirs: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(join(home, ".claude.json"), "utf-8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.projects)) dirs = Object.keys(parsed.projects);
  } catch {
    return [];
  }
  let picked: string[];
  if (root !== undefined) picked = dirs.filter((d) => d === root);
  else {
    const registered = new Set(Object.values(await readRegistry(dataDir)).map((e) => e.root));
    picked = dirs.filter((d) => registered.has(d) || registered.has(repoKey(d)));
  }
  const now = Date.now();
  const live = await Promise.all(picked.map((d) => hasLiveSession(home, d, now)));
  return picked.filter((_, i) => !live[i]);
}

/**
 * Prune between sessions, without the user running setup: `init` calls it for its own
 * project directory, the SessionEnd maintenance job for every registered one. Projects
 * with a live session are left for a later run. The Jev deadline starts before the scan. It only runs when
 * the opt-in Jev assist is on, a token exists and MCP prune itself is on, so turning
 * the opt-in off leaves both commands doing exactly what they did before. Holds the
 * machine-wide prune lock across plan and apply, and skips when another prune has it.
 * A running session keeps the MCP set it started with; the change reaches the next one.
 * Never throws.
 */
export async function autoPrune(opts: AutoPruneOptions): Promise<AutoPruneResult> {
  const deadline = Date.now() + JEV_RUN_DEADLINE_MS;
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
      jevDeadlineAt: deadline,
      poolPlannedOnly: true,
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
