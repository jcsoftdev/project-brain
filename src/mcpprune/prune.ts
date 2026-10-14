import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { discoverMcpConfigs, normalizeServerName } from "../toolcatalog/config.js";
import { classifyTool, emptyUsage, mergeUsage, scanUsage, type Usage } from "./usage.js";

const DAY = 86_400_000;
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
  /** Server names never disabled, on top of the keep list in the state file. */
  allow?: string[];
}

export interface Candidate {
  name: string;
  /** Also listed in `.mcp.json`, so it goes in both disabled lists. */
  mcpJson: boolean;
}

export interface ProjectPlan {
  project: string;
  skipped?: string;
  sessions: number;
  candidates: Candidate[];
}

interface Entry {
  project: string;
  name: string;
  keys: ListKey[];
  at: string;
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

const sinceOf = (env: PruneEnv, state: State): number =>
  Math.min((env.now ?? Date.now()) - (env.windowDays ?? 30) * DAY, ...state.disabled.map((e) => Date.parse(e.at) || Infinity));

/**
 * Claude Code rewrites `.claude.json` from memory, so an entry of ours can vanish by itself.
 * It counts as the user switching the server back on only if the repo called it since we
 * disabled it; otherwise it is dropped from the manifest and the server is a normal candidate again.
 */
function classifyVanished(root: Record<string, unknown>, state: State, p: Pool): { kept: Entry[]; dropped: Entry[] } {
  const kept: Entry[] = [];
  const dropped: Entry[] = [];
  for (const e of vanishedFrom(root, state)) {
    const at = Date.parse(e.at);
    const usage = p.usage.get(p.repoOf.get(e.project) ?? repoKey(e.project));
    const used = [...(usage?.lastUsed ?? [])].some(([tool, when]) => when > at && classifyTool(tool, [e.name])?.server === normalizeServerName(e.name));
    (used ? kept : dropped).push(e);
  }
  return { kept, dropped };
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
  const state = await loadState(env);
  const since = sinceOf(env, state);
  const { repoOf, usage: pooled } = await pool(env, dirs, since);
  const never = new Set(
    [...(env.allow ?? []), ...state.keep, ...classifyVanished(root, state, { repoOf, usage: pooled }).kept.map((e) => e.name), "project-brain"].map(normalizeServerName)
  );

  const plans: ProjectPlan[] = [];
  for (const project of only ?? dirs) {
    if (!dirs.includes(project)) continue;
    const usage = pooled.get(repoOf.get(project)!)!;
    const base = { project, sessions: usage.sessions, candidates: [] };
    if (!existsSync(project)) {
      plans.push({ ...base, skipped: "directory no longer exists" });
      continue;
    }
    const spanDays = usage.oldest !== null && usage.newest !== null ? (usage.newest - usage.oldest) / DAY : 0;
    if (usage.sessions < (env.minSessions ?? 10) && spanDays < (env.minSpanDays ?? 14)) {
      plans.push({ ...base, skipped: "not enough history yet" });
      continue;
    }
    const configs = await discoverMcpConfigs({ home: env.home, projectDir: project });
    const used = new Set(
      [...usage.lastUsed.keys()].flatMap((t) => {
        const c = classifyTool(t, [...configs.user, ...configs.project].map((s) => s.name));
        return c ? [c.server] : [];
      })
    );
    const inMcpJson = await mcpJsonNames(project);
    const seen = new Set<string>();
    const candidates = [...configs.user, ...configs.project]
      .filter((s) => {
        const n = normalizeServerName(s.name);
        return !never.has(n) && !used.has(n) && !seen.has(n) && seen.add(n);
      })
      .map((s) => ({ name: s.name, mcpJson: inMcpJson.has(s.name) }));
    plans.push({ ...base, candidates });
  }
  return plans;
}

const indentOf = (text: string): string | number => /^([ \t]+)"/m.exec(text)?.[1] ?? 2;

/**
 * Rewrites `~/.claude.json` through `mutate`, which edits the freshly read tree
 * and says whether it changed anything. Claude Code rewrites this file live, so
 * a change of mtime or size since the read means abort-and-retry (once), and the
 * result is read back to confirm it was not overwritten again.
 */
async function editClaudeJson(
  env: PruneEnv,
  mutate: (root: Record<string, unknown>) => boolean,
  landed: (root: Record<string, unknown>) => boolean
): Promise<{ outcome: "written" | "unchanged" | "lost"; backup: string | null }> {
  const file = claudeJsonPath(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await stat(file);
    const text = await readFile(file, "utf-8");
    const root = JSON.parse(text) as unknown;
    if (!isRecord(root)) throw new Error(`${file} is not a JSON object`);
    if (!mutate(root)) return { outcome: "unchanged", backup: null };
    const out = JSON.stringify(root, null, indentOf(text)) + (text.endsWith("\n") ? "\n" : "");
    const now = await stat(file);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue;
    const saved = await backup(env, text);
    await writeFileAtomic(file, out);
    const after = await readClaudeJson(env);
    return { outcome: after && landed(after) ? "written" : "lost", backup: saved };
  }
  throw new Error(`${file} kept changing while it was being edited`);
}

async function backup(env: PruneEnv, text: string): Promise<string> {
  const dir = join(env.dataDir, "mcp-prune");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `claude.json.${new Date(env.now ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.bak`);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export interface ApplyResult {
  added: Entry[];
  backup: string | null;
  error?: string;
}

/** Adds each plan's candidates to that project's own disabled lists, nowhere else. */
export async function applyPrune(env: PruneEnv, plans: ProjectPlan[]): Promise<ApplyResult> {
  const work = plans.filter((p) => !p.skipped && p.candidates.length > 0);
  try {
    const state = await loadState(env);
    let added: Entry[] = [];
    const current = await readClaudeJson(env);
    const dirs = Object.keys(isRecord(current?.projects) ? current.projects : {});
    const { kept, dropped } = current ? classifyVanished(current, state, await pool(env, dirs, sinceOf(env, state))) : { kept: [], dropped: [] };
    const newKeep = kept.map((e) => e.name);
    if (work.length === 0) {
      if (kept.length + dropped.length > 0) {
        const gone = new Set([...kept, ...dropped]);
        await saveState(env, { keep: [...new Set([...state.keep, ...newKeep])], disabled: state.disabled.filter((e) => !gone.has(e)) });
      }
      return { added: [], backup: null };
    }
    const { outcome, backup: saved } = await editClaudeJson(
      env,
      (root) => {
        added = [];
        const projects = isRecord(root.projects) ? root.projects : null;
        if (!projects) return false;
        const keep = new Set([...state.keep, ...newKeep, ...(env.allow ?? [])].map(normalizeServerName));
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
      }
    );
    if (outcome === "lost") return { added: [], backup: saved, error: "Claude Code overwrote ~/.claude.json right after the edit; nothing was recorded" };
    if (outcome === "unchanged") return { added: [], backup: null };
    const reenabledKept = newKeep.filter((n) => !state.keep.includes(n));
    const gone = new Set([...kept, ...dropped]);
    await saveState(env, { keep: [...state.keep, ...reenabledKept], disabled: [...state.disabled.filter((e) => !gone.has(e)), ...added] });
    return { added, backup: saved };
  } catch (e) {
    return { added: [], backup: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface RevertResult {
  removed: Entry[];
  error?: string;
}

/** Removes exactly the manifest's entries, keeps those servers off the prune list for good, and clears the manifest. */
export async function revertPrune(env: PruneEnv): Promise<RevertResult> {
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
