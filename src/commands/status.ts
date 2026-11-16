import { execFile, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, VERSION } from "../constants.js";
import { isScopedProjectId } from "../indexer/project-id.js";
import { isNewer } from "../notifier.js";
import type { StaleServer } from "../hooks/session-versions.js";
import { readRegistry } from "../store/project-registry.js";
import { resolveDefaultBranch } from "./worktree.js";
import {
  assessFinish,
  holdersIn,
  isInside,
  mergeTargets,
  parseWorktreeList,
  workLines,
  type WorktreeEntry,
} from "./worktree-lifecycle.js";

const GIT_CONCURRENCY = 8;
const NPM_TIMEOUT_MS = 3000;
const UNITS_TIMEOUT_MS = 2000;
const LISTED_ITEMS = 10;

export interface GitResult {
  ok: boolean;
  out: string;
}

export interface DistTags {
  latest?: string;
  next?: string;
}

export interface PendingUnit {
  id: string;
  label: string;
}

export interface UnitsInspection {
  pending: PendingUnit[];
  /** Units whose inspection did not answer within the budget: neither pending nor clear. */
  skipped: string[];
}

export interface StatusDeps {
  dataDir: string;
  installedVersion: string;
  /** The invoker's cwd, resolved: a worktree you stand in is never "safe to remove". */
  cwd: string;
  now: () => number;
  git: (cwd: string, args: string[]) => Promise<GitResult>;
  /** Null when npm could not answer in time. */
  distTags: () => Promise<DistTags | null>;
  /** Units setup could enable that the owner never declined. Null when they could not be inspected at all. */
  pendingUnits: () => Promise<UnitsInspection | null>;
  /** One process-table read, asked per worktree. Null holders mean "unknown", which blocks removal. */
  holders: () => Promise<(path: string) => number[] | null>;
  /** Live MCP servers not running `installed`. Null when that could not be determined. */
  staleServers?: (installed: string, dataDir: string) => Promise<StaleServer[] | null>;
}

export interface UnpushedBranch {
  branch: string;
  ahead: number;
  upstream: string | null;
  command: string;
}

export interface RemovableWorktree {
  path: string;
  branch: string;
  command: string;
}

export interface ProjectStatus {
  id: string;
  root: string;
  defaultBranch: string | null;
  remote: string | null;
  unpushed: UnpushedBranch[];
  dirty: { count: number; command: string } | null;
  worktrees: { count: number; removable: RemovableWorktree[] };
  clean: boolean;
}

export interface VersionStatus {
  installed: string;
  latest: string | null;
  next: string | null;
  updateAvailable: boolean;
  latestLags: boolean;
  commands: string[];
}

export interface StatusReport {
  projects: ProjectStatus[];
  units: (UnitsInspection & { command: string }) | null;
  version: VersionStatus;
  /** MCP servers still running an older version than the installed one; null when unknown. */
  servers: StaleServer[] | null;
  clean: boolean;
}

function gate(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) await new Promise<void>((resume) => queue.push(resume));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function run(cmd: string, args: string[], options: { cwd?: string; timeout?: number }): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...options, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: stdout ?? "" });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);
}

async function inspectUnits(): Promise<UnitsInspection> {
  const { probeContext } = await import("./setup.js");
  const { allUnits } = await import("../setup/units.js");
  const { loadSelection, membership } = await import("../setup/selection.js");
  const ctx = await probeContext();
  const selection = await loadSelection(ctx.selectionPath);
  const units = allUnits(ctx);
  const states = await Promise.all(units.map((u) => withTimeout(u.inspect(ctx), UNITS_TIMEOUT_MS, "timeout" as const)));
  return {
    pending: units.filter((u, i) => states[i] === "absent" && membership(selection, u.id) !== "declined").map((u) => ({ id: u.id, label: u.label })),
    skipped: units.filter((_, i) => states[i] === "timeout").map((u) => u.id),
  };
}

export function defaultStatusDeps(): StatusDeps {
  const limited = gate(GIT_CONCURRENCY);
  return {
    dataDir: DATA_DIR,
    installedVersion: VERSION,
    cwd: safeRealpath(process.cwd()),
    now: Date.now,
    git: (cwd, args) => limited(() => run("git", args, { cwd })),
    distTags: async () => {
      const r = await run("npm", ["view", "project-brain", "dist-tags", "--json"], { timeout: NPM_TIMEOUT_MS });
      if (!r.ok) return null;
      try {
        return JSON.parse(r.out) as DistTags;
      } catch {
        return null;
      }
    },
    pendingUnits: () => withTimeout(inspectUnits(), UNITS_TIMEOUT_MS + 500, null),
    holders: async () => {
      const r = await run("lsof", ["-d", "cwd", "-Fpn"], {});
      if (r.out.length === 0) return () => null;
      return (path) => holdersIn(r.out, path);
    },
    staleServers: async (installed, dataDir) => {
      // Without ps (Windows, slim containers) a record cannot be told from a recycled pid: unknown.
      // `now` is taken before ps runs: etime counts to the snapshot, not to whenever this resumes.
      const now = Date.now();
      const [meta, args] = await Promise.all([
        run("ps", ["-Ao", "pid=,ppid=,uid=,etime=,comm="], { timeout: 3000 }),
        run("ps", ["-Ao", "pid=,args="], { timeout: 3000 }),
      ]);
      if (!meta.ok || !args.ok) return null;
      const { liveServers, parseProcessTable, pruneSwapFailures, staleServers } = await import("../hooks/session-versions.js");
      const { resolveLauncher } = await import("../server/supervisor.js");
      const rows = parseProcessTable(meta.out, args.out, now);
      const installedAt = (() => {
        try {
          return statSync(realpathSync(resolveLauncher().watch)).ctimeMs;
        } catch {
          return null;
        }
      })();
      await pruneSwapFailures(dataDir, rows, now);
      return staleServers(rows, await liveServers(dataDir, rows, now), installed, { uid: process.getuid?.(), installedAt });
    },
  };
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Display a path the way a shell accepts it: `~/` for home, single quotes when anything needs them. */
export function shellPath(path: string, home: string = homedir()): string {
  const plain = /^[A-Za-z0-9_./@%+=:,-]+$/;
  if (path.startsWith(`${home}/`) && plain.test(path.slice(home.length))) return `~${path.slice(home.length)}`;
  return plain.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function lines(out: string): string[] {
  return out.split("\n").filter((l) => l.length > 0);
}

/** "[ahead 3]", "[ahead 3, behind 1]", "[behind 2]", "[gone]" or "". */
function aheadOf(track: string): number {
  const m = /ahead (\d+)/.exec(track);
  return m ? Number(m[1]) : 0;
}

interface Ref {
  branch: string;
  upstream: string;
  remote: string;
  track: string;
  sha: string;
}

async function collectProject(id: string, root: string, deps: StatusDeps, holdersOf: (p: string) => number[] | null): Promise<ProjectStatus | null> {
  const list = await deps.git(root, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return null;
  const entries: WorktreeEntry[] = parseWorktreeList(list.out).map((e) => ({ ...e, path: safeRealpath(e.path) }));
  if (entries.length === 0) return null;
  const mainRoot = entries[0]!.path;
  const g = (args: string[], cwd = mainRoot) => deps.git(cwd, args);

  const [defaultBranch, remotes, refs, status] = await Promise.all([
    Promise.resolve(resolveDefaultBranch(mainRoot, spawnSync)),
    g(["remote"]),
    g(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:remotename)%09%(upstream:track)%09%(objectname)"]),
    g(["status", "--porcelain=v1", "-uall"]),
  ]);

  const remoteNames = lines(remotes.out);
  const remote = remoteNames.includes("origin") ? "origin" : (remoteNames[0] ?? null);
  const branches: Ref[] = lines(refs.out).map((l) => {
    const [branch = "", upstream = "", remoteName = "", track = "", sha = ""] = l.split("\t");
    return { branch, upstream, remote: remoteName, track, sha };
  });
  const targets = defaultBranch ? mergeTargets(defaultBranch) : [];
  const [mergedLists, targetTips] = await Promise.all([
    Promise.all(targets.map((t) => g(["branch", "--merged", t, "--format=%(refname:short)"]))),
    Promise.all(targets.map((t) => g(["rev-parse", t]))),
  ]);
  const merged = new Set(mergedLists.flatMap((r) => lines(r.out)));
  const mergedKnown = mergedLists.length > 0 && mergedLists.every((r) => r.ok);
  const tips = new Set(targetTips.filter((r) => r.ok).map((r) => r.out.trim()));
  const localDefault = defaultBranch?.replace(/^origin\//, "") ?? null;
  const at = `git -C ${shellPath(mainRoot)}`;

  const unpushed: UnpushedBranch[] = [];
  if (remote) {
    const tracked = branches.filter((b) => b.upstream && !b.track.includes("gone") && aheadOf(b.track) > 0);
    for (const b of tracked) {
      unpushed.push({ branch: b.branch, ahead: aheadOf(b.track), upstream: b.upstream, command: `${at} push ${b.remote || remote} ${b.branch}` });
    }
    const untracked = branches.filter((b) => (!b.upstream || b.track.includes("gone")) && b.branch !== localDefault && mergedKnown && !merged.has(b.branch));
    const counts = await Promise.all(untracked.map((b) => g(["rev-list", "--count", b.branch, "--not", ...targets])));
    untracked.forEach((b, i) => {
      const ahead = Number(counts[i]!.out.trim());
      if (counts[i]!.ok && ahead > 0) unpushed.push({ branch: b.branch, ahead, upstream: null, command: `${at} push -u ${remote} ${b.branch}` });
    });
  }

  const mainDirt = status.ok ? workLines(status.out, mainRoot).dirty : [];
  const dirty = mainDirt.length > 0 ? { count: mainDirt.length, command: `${at} status` } : null;

  const linked = entries.filter((e) => !e.isMain);
  const tipBySha = new Map(branches.map((b) => [b.branch, b.sha]));
  const facts = await Promise.all(
    linked.map(async (entry) => {
      const exists = existsSync(entry.path);
      const porcelain = exists ? await g(["status", "--porcelain=v1", "-uall", "--ignore-submodules=none"], entry.path) : { ok: true, out: "" };
      const work = porcelain.ok ? workLines(porcelain.out, entry.path) : { dirty: ["git status failed"], nodeModulesSymlink: false };
      let ageMs: number | null = null;
      try {
        ageMs = deps.now() - statSync(join(entry.path, ".git")).birthtimeMs;
      } catch {
        // unknown age: the grace rule does not apply
      }
      const branchMerged = entry.branch === null ? null : merged.has(entry.branch) ? true : mergedKnown ? false : null;
      const verdict = assessFinish({
        isMain: false,
        branch: entry.branch,
        defaultBranch,
        locked: entry.locked,
        prunable: entry.prunable,
        merged: branchMerged,
        tipIsDefaultTip: entry.branch !== null && tips.has(tipBySha.get(entry.branch) ?? ""),
        ageMs,
        dirty: work.dirty,
        holders: exists ? holdersOf(entry.path) : [],
        cwdInside: isInside(deps.cwd, entry.path),
      });
      return { entry, finished: verdict.finished, nodeModulesSymlink: work.nodeModulesSymlink };
    })
  );
  const removable: RemovableWorktree[] = facts
    .filter((f) => f.finished)
    .map(({ entry, nodeModulesSymlink }) => {
      const remove = `${at} worktree remove ${shellPath(entry.path)}`;
      return {
        path: entry.path,
        branch: entry.branch!,
        command: nodeModulesSymlink ? `rm ${shellPath(join(entry.path, "node_modules"))} && ${remove}` : remove,
      };
    });

  return {
    id,
    root: mainRoot,
    defaultBranch,
    remote,
    unpushed,
    dirty,
    worktrees: { count: linked.length, removable },
    clean: unpushed.length === 0 && dirty === null && removable.length === 0,
  };
}

function versionStatus(installed: string, tags: DistTags | null): VersionStatus {
  const latest = typeof tags?.latest === "string" ? tags.latest : null;
  const next = typeof tags?.next === "string" ? tags.next : null;
  const updateAvailable = latest !== null && isNewer(latest, installed);
  const latestLags = latest !== null && next !== null && isNewer(next, latest);
  const commands: string[] = [];
  if (updateAvailable) commands.push("project-brain update");
  if (latestLags) commands.push(`npm dist-tag add project-brain@${next} latest`);
  return { installed, latest, next, updateAvailable, latestLags, commands };
}

export class UnknownProjectError extends Error {}

/** Everything pending across registered projects, read-only. */
export async function collectStatus(deps: StatusDeps, options: { project?: string } = {}): Promise<StatusReport> {
  const registry = await readRegistry(deps.dataDir);
  if (options.project !== undefined && !registry[options.project]) throw new UnknownProjectError(`unknown project "${options.project}"`);
  const candidates = Object.entries(registry)
    .filter(([id, entry]) => (options.project !== undefined ? id === options.project : !isScopedProjectId(id)) && existsSync(entry.root))
    .sort(([a], [b]) => a.localeCompare(b));

  const tagsPromise = deps.distTags().catch(() => null);
  const unitsPromise = deps.pendingUnits().catch(() => null);
  const holdersOf = await deps.holders().catch(() => () => null);
  const serversPromise = deps.staleServers ? deps.staleServers(deps.installedVersion, deps.dataDir).catch(() => null) : Promise.resolve(null);

  const collected = await Promise.all(candidates.map(([id, entry]) => collectProject(id, entry.root, deps, holdersOf).catch(() => null)));
  const seen = new Set<string>();
  const projects = collected.filter((p): p is ProjectStatus => {
    if (p === null || seen.has(p.root)) return false;
    seen.add(p.root);
    return true;
  });

  const inspection = await unitsPromise;
  const units = inspection === null ? null : { ...inspection, command: "project-brain setup" };
  const version = versionStatus(deps.installedVersion, await tagsPromise);
  const servers = await serversPromise;
  const clean =
    projects.every((p) => p.clean) && (units?.pending.length ?? 0) === 0 && version.commands.length === 0 && (servers?.length ?? 0) === 0;
  return { projects, units, version, servers, clean };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatStatus(report: StatusReport): string {
  if (report.clean) return `All clear: ${plural(report.projects.length, "project")} checked, nothing pending.`;
  const out: string[] = [];
  const row = (kind: string, detail: string, command?: string) => {
    out.push(`  ${kind.padEnd(10)} ${detail}`);
    if (command) out.push(`  ${"".padEnd(10)} $ ${command}`);
  };

  for (const p of report.projects.filter((x) => !x.clean)) {
    out.push(`${p.id}  ${shellPath(p.root)}`);
    for (const u of p.unpushed.slice(0, LISTED_ITEMS)) {
      const where = u.upstream ? `ahead of ${u.upstream}` : "with no upstream";
      row("unpushed", `${u.branch}: ${plural(u.ahead, "commit")} ${where}`, u.command);
    }
    const hidden = p.unpushed.length - LISTED_ITEMS;
    if (hidden > 0) row("", `... and ${hidden} more ${hidden === 1 ? "branch" : "branches"}`, `project-brain status --json --project ${p.id}`);
    if (p.dirty) row("dirty", plural(p.dirty.count, "uncommitted change"), p.dirty.command);
    if (p.worktrees.removable.length > 0) {
      row("worktrees", `${p.worktrees.count} total, ${p.worktrees.removable.length} merged and safe to remove`);
      for (const w of p.worktrees.removable.slice(0, LISTED_ITEMS)) row("", `${w.path.split("/").pop()} (${w.branch})`, w.command);
      const rest = p.worktrees.removable.length - LISTED_ITEMS;
      if (rest > 0) row("", `... and ${rest} more`, `cd ${shellPath(p.root)} && project-brain worktree sweep --yes`);
    }
    out.push("");
  }

  const global: string[] = [];
  if (report.units === null) global.push(`  ${"setup".padEnd(10)} could not inspect setup units`);
  else if (report.units.pending.length > 0) {
    const skipped = report.units.skipped.length > 0 ? ` (not checked in time: ${report.units.skipped.join(", ")})` : "";
    global.push(`  ${"setup".padEnd(10)} ${plural(report.units.pending.length, "unit")} available but not enabled: ${report.units.pending.map((u) => u.id).join(", ")}${skipped}`);
    global.push(`  ${"".padEnd(10)} $ ${report.units.command}`);
  }
  const v = report.version;
  if (v.latest === null) global.push(`  ${"version".padEnd(10)} installed ${v.installed}; npm did not answer`);
  else if (v.commands.length > 0) {
    const notes = [v.updateAvailable ? `latest ${v.latest} is newer` : null, v.latestLags ? `latest ${v.latest} lags next ${v.next}` : null].filter(Boolean);
    global.push(`  ${"version".padEnd(10)} installed ${v.installed}; ${notes.join("; ")}`);
    for (const c of v.commands) global.push(`  ${"".padEnd(10)} $ ${c}`);
  }
  global.push(...formatStaleServers(report.servers ?? [], v.installed));
  if (global.length > 0) out.push("global", ...global);
  else if (out.at(-1) === "") out.pop();
  return out.join("\n");
}

function age(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  return hours >= 1 ? `${hours}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** One line per server: "MCP server runs 0.42.0, installed 0.45.1", and the fix once at the end. */
export function formatStaleServers(servers: StaleServer[], installed: string, now: number = Date.now()): string[] {
  if (servers.length === 0) return [];
  const pad = "".padEnd(10);
  const lines = servers.slice(0, LISTED_ITEMS).map((s, i) => {
    const runs = s.version ? `runs ${s.version}` : "runs an older version";
    const where = [`pid ${s.pid}`, s.cwd ? shellPath(s.cwd) : null, `up ${age(now - s.startedAt)}`].filter(Boolean).join(", ");
    return `  ${(i === 0 ? "mcp" : "").padEnd(10)} MCP server ${runs}, installed ${installed} (${where})`;
  });
  const hidden = servers.length - LISTED_ITEMS;
  if (hidden > 0) lines.push(`  ${pad} ... and ${hidden} more`);
  lines.push(`  ${pad} fix: run /mcp reconnect in each of those Claude Code sessions, or restart them`);
  return lines;
}

export async function execute(args: string[], deps: StatusDeps = defaultStatusDeps()): Promise<void> {
  const i = args.indexOf("--project");
  const project = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && (!project || project.startsWith("--"))) {
    console.error("Usage: project-brain status [--json] [--project <id>]");
    process.exitCode = 1;
    return;
  }
  try {
    const report = await collectStatus(deps, { project });
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatStatus(report));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
