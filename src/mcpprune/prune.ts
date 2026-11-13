import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { discoverMcpConfigs, normalizeServerName, type McpServerConfig } from "../toolcatalog/config.js";
import { readRegistry } from "../store/project-registry.js";
import { judgeable, judgeServers, projectSignals, type JevSettings, type JudgeRun, type ServerBrief } from "./judge.js";
import { classifyTool, emptyUsage, mergeUsage, scanUsage, type Usage } from "./usage.js";

const DAY = 86_400_000;
const KEEP_BACKUPS = 5;
/** Below this probability of being needed, Jev's word disables a server in a project with thin history. */
export const JEV_PRUNE_BELOW = 0.2;
/** Repos Jev is asked about per run; cached answers do not count. */
export const MAX_JEV_REQUESTS = 20;
/** Wall-clock budget for all of a run's Jev requests; what is unanswered by then is kept. */
export const JEV_RUN_DEADLINE_MS = 15_000;
export const AWAITING_JEV = "not enough history yet; Jev will be asked on apply";
export const DISABLED_KEY = "disabledMcpServers";
export const DISABLED_JSON_KEY = "disabledMcpjsonServers";
type ListKey = typeof DISABLED_KEY | typeof DISABLED_JSON_KEY;

export interface PruneEnv {
  /** Directory holding `.claude.json` and `.claude/projects`. */
  home: string;
  /** Where the manifest and backups live. */
  dataDir: string;
  now?: number;
  windowDays?: number;
  minSessions?: number;
  minSpanDays?: number;
  /** Sessions inside the window that a long-but-sparse history still needs. */
  minRecentSessions?: number;
  /** Server names never disabled, on top of the keep list in the state file. */
  allow?: string[];
  /**
   * When set, a project registered with project-brain whose history is too thin to
   * judge by usage asks Jev, once per repo and cached, which of its unused servers it
   * will need. Absent or failing: such a project is skipped, as it always was.
   */
  jev?: JevSettings | null;
  /** True only when the plan is about to be applied: then Jev may be asked and its answers cached. Otherwise only cached answers count. */
  askJev?: boolean;
  /** Overrides {@link JEV_RUN_DEADLINE_MS}. */
  jevDeadlineMs?: number;
  /** Absolute wall-clock deadline for Jev, set by a caller that started its clock earlier; wins over `jevDeadlineMs`. */
  jevDeadlineAt?: number;
  /**
   * Pool usage over the planned projects only instead of every project in `~/.claude.json`.
   * Automatic runs set it so their scan stays small; worktrees then do not inherit siblings' history.
   */
  poolPlannedOnly?: boolean;
  /** How long `revertPrune` waits for another prune to finish. Defaults to {@link REVERT_LOCK_WAIT_MS}. */
  revertWaitMs?: number;
  /** Test seam: runs after the edit is computed and just before the rename of `~/.claude.json`. */
  beforeRename?: () => void | Promise<void>;
}

export interface Candidate {
  name: string;
  /** Also listed in `.mcp.json`, so it goes in both disabled lists. */
  mcpJson: boolean;
  /** Jev's probability that the project needs it, when Jev made the call. */
  needed?: number;
}

export interface ProjectPlan {
  project: string;
  skipped?: string;
  sessions: number;
  candidates: Candidate[];
  /** "jev" when history was too thin and Jev chose the candidates. */
  basis?: "jev";
  /** Jev's answer is not cached yet and this plan may not ask; applying would. */
  awaitingJev?: true;
}

interface Entry {
  project: string;
  name: string;
  keys: ListKey[];
  at: string;
  /** Recorded before `~/.claude.json` is written and confirmed once the edit landed. */
  pending?: true;
}

interface State {
  keep: string[];
  disabled: Entry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const claudeJsonPath = (env: PruneEnv) => join(env.home, ".claude.json");
const statePath = (env: PruneEnv) => join(env.dataDir, "mcp-prune.json");

export const envFromProcess = (): { windowDays?: number; allow: string[] } => ({
  windowDays: Number(process.env.PROJECT_BRAIN_MCP_PRUNE_DAYS) > 0 ? Number(process.env.PROJECT_BRAIN_MCP_PRUNE_DAYS) : undefined,
  allow: (process.env.PROJECT_BRAIN_MCP_PRUNE_KEEP ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});

/** Throws when the file exists but is unreadable as a state: callers abort rather than guess. */
async function loadState(env: PruneEnv): Promise<State> {
  let text: string;
  try {
    text = await readFile(statePath(env), "utf-8");
  } catch {
    return { keep: [], disabled: [] };
  }
  const raw = JSON.parse(text) as unknown;
  if (!isRecord(raw)) throw new Error("mcp-prune.json is not an object");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.filter((e): e is Entry => isRecord(e) && typeof e.project === "string" && typeof e.name === "string" && Array.isArray(e.keys))
    : [];
  return { keep: strings(raw.keep), disabled };
}

const saveState = (env: PruneEnv, state: State) => writeFileAtomic(statePath(env), `${JSON.stringify(state, null, 2)}\n`);

async function readClaudeJson(env: PruneEnv): Promise<Record<string, unknown> | null> {
  try {
    const root = JSON.parse(await readFile(claudeJsonPath(env), "utf-8")) as unknown;
    return isRecord(root) ? root : null;
  } catch {
    return null;
  }
}

const listOf = (entry: Record<string, unknown> | undefined, key: ListKey): string[] =>
  Array.isArray(entry?.[key]) ? (entry![key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

/**
 * Claude Code may rewrite `.claude.json` from memory, but a vanished entry is just as likely the
 * user switching the server back on in `/mcp`. Intent wins: it is kept off the prune list for good.
 */
const vanishedFrom = (root: Record<string, unknown>, state: State): Entry[] => {
  const projects = isRecord(root.projects) ? root.projects : {};
  return state.disabled.filter((e) => {
    const p = projects[e.project];
    return isRecord(p) && e.keys.some((k) => !listOf(p, k).includes(e.name));
  });
};

interface Pool {
  repoOf: Map<string, string>;
  usage: Map<string, Usage>;
}

/** Usage pooled per repo over every project in `.claude.json`, reading transcripts touched since `sinceMs`. */
async function pool(env: PruneEnv, dirs: string[], sinceMs: number): Promise<Pool> {
  const repoOf = new Map(dirs.map((d) => [d, repoKey(d)]));
  const usage = new Map<string, Usage>();
  for (const d of dirs) {
    const key = repoOf.get(d)!;
    usage.set(key, mergeUsage(usage.get(key) ?? emptyUsage(), await scanUsage(join(env.home, ".claude", "projects"), d, sinceMs)));
  }
  return { repoOf, usage };
}

const sinceOf = (env: PruneEnv): number => (env.now ?? Date.now()) - (env.windowDays ?? 30) * DAY;

/** Pending entries whose edit landed become confirmed; the rest never reached the file and are dropped. */
function settlePending(root: Record<string, unknown>, state: State): State {
  const projects = isRecord(root.projects) ? root.projects : {};
  const disabled = state.disabled.flatMap((e) => {
    if (!e.pending) return [e];
    const p = projects[e.project];
    const landed = isRecord(p) && e.keys.some((k) => listOf(p, k).includes(e.name));
    const { pending: _, ...confirmed } = e;
    return landed ? [confirmed] : [];
  });
  return { ...state, disabled };
}

/** The repo a project directory belongs to: its git common dir's parent, or the part before `/.claude/worktrees/`. */
export function repoKey(dir: string): string {
  if (existsSync(dir)) {
    const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
    const out = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    if (out) {
      const common = resolve(dir, out);
      return common.endsWith("/.git") ? dirname(common) : common;
    }
  }
  const at = dir.indexOf("/.claude/worktrees/");
  return at > 0 ? dir.slice(0, at) : dir;
}

async function mcpJsonNames(dir: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8")) as { mcpServers?: unknown };
    return new Set(isRecord(parsed.mcpServers) ? Object.keys(parsed.mcpServers) : []);
  } catch {
    return new Set();
  }
}

/**
 * Per project: the enabled servers it has never called within the window.
 * Usage and history are pooled across every project of the same repo, so a
 * worktree inherits what its siblings used. `only` limits which projects are
 * planned; the pooling still looks at all of them. Never throws.
 */
export async function planPrune(env: PruneEnv, only?: string[]): Promise<ProjectPlan[]> {
  try {
    return await plan(env, only);
  } catch {
    return [];
  }
}

async function plan(env: PruneEnv, only?: string[]): Promise<ProjectPlan[]> {
  const root = await readClaudeJson(env);
  if (!root || !isRecord(root.projects)) return [];
  const now = env.now ?? Date.now();
  const windowMs = (env.windowDays ?? 30) * DAY;
  const dirs = Object.keys(root.projects);
  const state = settlePending(root, await loadState(env));
  const since = sinceOf(env);
  const { repoOf, usage: pooled } = await pool(env, env.poolPlannedOnly && only ? only.filter((d) => dirs.includes(d)) : dirs, since);
  const never = new Set(
    [...(env.allow ?? []), ...state.keep, ...vanishedFrom(root, state).map((e) => e.name), "project-brain"].map(normalizeServerName)
  );

  const registered = env.jev ? new Set(Object.values(await readRegistry(env.dataDir)).map((e) => e.root)) : new Set<string>();
  const run: JudgeRun | null = env.jev
    ? {
        jev: env.jev,
        dataDir: env.dataDir,
        now,
        ask: env.askJev === true,
        deadline: env.jevDeadlineAt ?? Date.now() + (env.jevDeadlineMs ?? JEV_RUN_DEADLINE_MS),
        requestsLeft: MAX_JEV_REQUESTS,
      }
    : null;
  const plans: ProjectPlan[] = [];
  for (const project of only ?? dirs) {
    if (!dirs.includes(project)) continue;
    const repo = repoOf.get(project)!;
    const usage = pooled.get(repo)!;
    const base = { project, sessions: usage.sessions, candidates: [] };
    if (!existsSync(project)) {
      plans.push({ ...base, skipped: "directory no longer exists" });
      continue;
    }
    const spanDays = usage.oldest !== null && usage.newest !== null ? (usage.newest - usage.oldest) / DAY : 0;
    const longHistory = spanDays >= (env.minSpanDays ?? 14) && usage.recent >= (env.minRecentSessions ?? 3);
    const thin = usage.sessions < (env.minSessions ?? 10) && !longHistory;
    const jevMayJudge = run && usage.recent > 0 && !insideGitDir(project) && (registered.has(project) || registered.has(repo));
    if (thin && !jevMayJudge) {
      plans.push({ ...base, skipped: "not enough history yet" });
      continue;
    }
    const unused = await unusedServers(env, project, usage, never);
    if (!thin) {
      plans.push({ ...base, candidates: unused });
      continue;
    }
    const briefs = unused.map((s) => briefOf(s.name, usage)).filter(judgeable);
    if (briefs.length === 0) {
      plans.push({ ...base, candidates: [], basis: "jev" });
      continue;
    }
    const verdict = await judgeServers(run!, repo, await projectSignals(existsSync(repo) ? repo : project), briefs);
    if (!verdict) {
      plans.push({ ...base, skipped: "not enough history yet" });
      continue;
    }
    if ("pending" in verdict) {
      plans.push({ ...base, skipped: AWAITING_JEV, awaitingJev: true });
      continue;
    }
    const candidates = unused.flatMap((s) => {
      const needed = verdict.needed.get(s.name);
      return needed !== undefined && needed < JEV_PRUNE_BELOW ? [{ name: s.name, mcpJson: s.mcpJson, needed }] : [];
    });
    plans.push({ ...base, candidates, basis: "jev" });
  }
  return plans;
}

/** Enabled servers of `project` that its repo has not called within the window and that may be pruned at all. */
async function unusedServers(env: PruneEnv, project: string, usage: Usage, never: Set<string>): Promise<Array<{ name: string; mcpJson: boolean }>> {
  const configs = await discoverMcpConfigs({ home: env.home, projectDir: project });
  const all: McpServerConfig[] = [...configs.user, ...configs.project];
  const used = new Set(
    [...usage.lastUsed.keys()].flatMap((t) => {
      const c = classifyTool(t, all.map((s) => s.name));
      return c ? [c.server] : [];
    })
  );
  const inMcpJson = await mcpJsonNames(project);
  const seen = new Set<string>();
  return all
    .filter((s) => {
      const n = normalizeServerName(s.name);
      return !never.has(n) && !used.has(n) && !seen.has(n) && seen.add(n);
    })
    .map((s) => ({ name: s.name, mcpJson: inMcpJson.has(s.name) }));
}

/** The tools and instructions the project's own sessions were given for `name`; only the tool names are ever sent. */
function briefOf(name: string, usage: Usage): ServerBrief {
  const prefix = `mcp__${normalizeServerName(name)}__`;
  const tools = [...usage.announced].filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).sort();
  const seen = usage.instructions.get(name);
  return { name, tools, ...(seen ? { instructions: seen.text } : {}) };
}

/** A bare repo, a `.git` directory or a submodule's internals: never a project worth describing. */
const insideGitDir = (dir: string): boolean => /(^|\/)\.git(\/|$)/.test(dir) || dir.endsWith(".git");

const indentOf = (text: string): string | number => /^([ \t]+)"/m.exec(text)?.[1] ?? 2;

/**
 * Rewrites `~/.claude.json` through `mutate`, which edits the freshly read tree
 * and says whether it changed anything. Claude Code rewrites this file live, so
 * right before the rename the file is compared with what was parsed (stat and
 * content); a difference means abort-and-retry once. The result is read back to
 * confirm it was not overwritten again. `beforeWrite` runs once the backup is
 * taken and the edit is known, for bookkeeping that must precede the write.
 */
async function editClaudeJson(
  env: PruneEnv,
  mutate: (root: Record<string, unknown>) => boolean,
  landed: (root: Record<string, unknown>) => boolean,
  beforeWrite?: () => Promise<void>
): Promise<{ outcome: "written" | "unchanged" | "lost"; backup: string | null }> {
  const file = claudeJsonPath(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await stat(file);
    const text = await readFile(file, "utf-8");
    const root = JSON.parse(text) as unknown;
    if (!isRecord(root)) throw new Error(`${file} is not a JSON object`);
    if (!mutate(root)) return { outcome: "unchanged", backup: null };
    const out = JSON.stringify(root, null, indentOf(text)) + (text.endsWith("\n") ? "\n" : "");
    const saved = await backup(env, text);
    await beforeWrite?.();
    const unchanged = async (): Promise<boolean> => {
      await env.beforeRename?.();
      const now = await stat(file);
      return now.mtimeMs === before.mtimeMs && now.size === before.size && (await readFile(file, "utf-8")) === text;
    };
    if (!(await writeFileAtomic(file, out, { beforeRename: unchanged }))) continue;
    const after = await readClaudeJson(env);
    return { outcome: after && landed(after) ? "written" : "lost", backup: saved };
  }
  throw new Error(`${file} kept changing while it was being edited`);
}

/** The `~/.claude.json` from before the very first prune, kept for good beside the rotating backups. */
export const BASELINE_BACKUP = "baseline-claude.json.bak";

async function backup(env: PruneEnv, text: string): Promise<string> {
  const dir = join(env.dataDir, "mcp-prune");
  await mkdir(dir, { recursive: true });
  const baseline = join(dir, BASELINE_BACKUP);
  if (!existsSync(baseline)) {
    await writeFile(baseline, text, { mode: 0o600 });
    await chmod(baseline, 0o600);
  }
  const file = join(dir, `claude.json.${new Date(env.now ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.bak`);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  const old = (await readdir(dir)).filter((n) => n.startsWith("claude.json.") && n.endsWith(".bak")).sort().slice(0, -KEEP_BACKUPS);
  await Promise.all(old.map((n) => rm(join(dir, n), { force: true })));
  return file;
}

export interface ApplyResult {
  added: Entry[];
  backup: string | null;
  error?: string;
  /** Another prune held the machine-wide lock, so this one changed nothing. */
  locked?: true;
}

/** One prune at a time per machine: setup, `mcp prune --apply`, init and maintain can overlap. */
export const pruneLockPath = (env: PruneEnv) => join(env.dataDir, "mcp-prune.lock");

/** How long an explicit revert waits for a running prune before telling the user to retry. */
export const REVERT_LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 200;

/**
 * Runs `work` holding the prune lock; resolves to null when another prune holds it for
 * longer than `waitMs` (0, the default, means try once: automatic runs just skip).
 */
export async function withPruneLock<T>(env: PruneEnv, work: () => Promise<T>, waitMs = 0): Promise<T | null> {
  const { acquirePidFileLock } = await import("../commands/sync-lock.js");
  const giveUpAt = Date.now() + waitMs;
  let lock = await acquirePidFileLock(pruneLockPath(env)).catch(() => null);
  while (!lock && Date.now() < giveUpAt) {
    await Bun.sleep(Math.min(LOCK_POLL_MS, Math.max(0, giveUpAt - Date.now())));
    lock = await acquirePidFileLock(pruneLockPath(env)).catch(() => null);
  }
  if (!lock) return null;
  try {
    return await work();
  } finally {
    await lock.release().catch(() => {});
  }
}

/**
 * Adds each plan's candidates to that project's own disabled lists, nowhere else.
 * The entries are in the manifest, marked pending, before the file is written, so
 * `--revert` sees everything that may have landed even if the process dies in between.
 */
export async function applyPrune(env: PruneEnv, plans: ProjectPlan[]): Promise<ApplyResult> {
  return (await withPruneLock(env, () => applyUnlocked(env, plans))) ?? { added: [], backup: null, locked: true };
}

/** {@link applyPrune} for a caller that already holds the prune lock. */
export async function applyUnlocked(env: PruneEnv, plans: ProjectPlan[]): Promise<ApplyResult> {
  const work = plans.filter((p) => !p.skipped && p.candidates.length > 0);
  let base: State | null = null;
  let pendingSaved = false;
  try {
    const loaded = await loadState(env);
    const current = await readClaudeJson(env);
    const state = current ? settlePending(current, loaded) : loaded;
    const vanished = current ? vanishedFrom(current, state) : [];
    const gone = new Set(vanished);
    const settled: State = {
      keep: [...new Set([...state.keep, ...vanished.map((e) => e.name)])],
      disabled: state.disabled.filter((e) => !gone.has(e)),
    };
    base = settled;
    const persist = async (next: State) => {
      if (JSON.stringify(next) !== JSON.stringify(loaded)) await saveState(env, next);
    };
    if (work.length === 0) {
      await persist(settled);
      return { added: [], backup: null };
    }
    let added: Entry[] = [];
    const { outcome, backup: saved } = await editClaudeJson(
      env,
      (root) => {
        added = [];
        const projects = isRecord(root.projects) ? root.projects : null;
        if (!projects) return false;
        const keep = new Set([...settled.keep, ...(env.allow ?? [])].map(normalizeServerName));
        for (const p of work) {
          const entry = projects[p.project];
          if (!isRecord(entry)) continue;
          for (const c of p.candidates) {
            if (keep.has(normalizeServerName(c.name))) continue;
            const keys: ListKey[] = c.mcpJson ? [DISABLED_KEY, DISABLED_JSON_KEY] : [DISABLED_KEY];
            const ours = keys.filter((k) => {
              const cur = entry[k];
              if (cur !== undefined && !Array.isArray(cur)) return false;
              const list = (cur as unknown[] | undefined) ?? [];
              if (list.includes(c.name)) return false;
              entry[k] = [...list, c.name];
              return true;
            });
            if (ours.length > 0) added.push({ project: p.project, name: c.name, keys: ours, at: new Date(env.now ?? Date.now()).toISOString() });
          }
        }
        return added.length > 0;
      },
      (root) => {
        const projects = isRecord(root.projects) ? root.projects : {};
        return added.every((e) => e.keys.every((k) => listOf(projects[e.project] as Record<string, unknown>, k).includes(e.name)));
      },
      async () => {
        await saveState(env, { ...settled, disabled: [...settled.disabled, ...added.map((e) => ({ ...e, pending: true as const }))] });
        pendingSaved = true;
      }
    );
    if (outcome === "lost") {
      await saveState(env, settled);
      return { added: [], backup: saved, error: "Claude Code overwrote ~/.claude.json right after the edit; nothing was recorded" };
    }
    if (outcome === "unchanged") {
      await persist(settled);
      return { added: [], backup: null };
    }
    await saveState(env, { ...settled, disabled: [...settled.disabled, ...added] });
    return { added, backup: saved };
  } catch (e) {
    if (base && pendingSaved) await saveState(env, base).catch(() => {});
    return { added: [], backup: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True when we have disabled something that `--revert` could still undo. Never throws. */
export async function hasPruneEntries(env: PruneEnv): Promise<boolean> {
  try {
    return (await loadState(env)).disabled.length > 0;
  } catch {
    return false;
  }
}

export interface RevertResult {
  removed: Entry[];
  error?: string;
}

/**
 * Removes exactly the manifest's entries, keeps those servers off the prune list for good, and clears the manifest.
 * Holds the prune lock, waiting for a running prune rather than skipping: an apply landing mid-revert would
 * disable a server the cleared manifest no longer records.
 */
export async function revertPrune(env: PruneEnv): Promise<RevertResult> {
  const result = await withPruneLock(env, () => revertUnlocked(env), env.revertWaitMs ?? REVERT_LOCK_WAIT_MS);
  return result ?? { removed: [], error: "another MCP prune is still running (setup, init or session-end maintenance); nothing was reverted, try again in a moment" };
}

async function revertUnlocked(env: PruneEnv): Promise<RevertResult> {
  try {
    const state = await loadState(env);
    if (state.disabled.length === 0) return { removed: [] };
    const outcome = existsSync(claudeJsonPath(env))
      ? (await editClaudeJson(
          env,
          (root) => {
            const projects = isRecord(root.projects) ? root.projects : {};
            let changed = false;
            for (const e of state.disabled) {
              const p = projects[e.project];
              if (!isRecord(p)) continue;
              for (const k of e.keys) {
                if (listOf(p, k).includes(e.name)) {
                  p[k] = listOf(p, k).filter((n) => n !== e.name);
                  changed = true;
                }
              }
            }
            return changed;
          },
          (root) => {
            const projects = isRecord(root.projects) ? root.projects : {};
            return state.disabled.every((e) => e.keys.every((k) => !listOf(projects[e.project] as Record<string, unknown>, k).includes(e.name)));
          }
        )).outcome
      : "unchanged";
    if (outcome === "lost") return { removed: [], error: "Claude Code overwrote ~/.claude.json right after the edit; manifest kept" };
    await saveState(env, { keep: [...new Set([...state.keep, ...state.disabled.map((e) => e.name)])], disabled: [] });
    return { removed: state.disabled };
  } catch (e) {
    return { removed: [], error: e instanceof Error ? e.message : String(e) };
  }
}
