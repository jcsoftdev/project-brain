import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { DATA_DIR } from "../constants.js";
import { discoverMcpConfigs, fingerprintConfigs, normalizeServerName } from "./config.js";
import { listAllServers, type ToolEntry, type ToolLister } from "./live.js";
import { scanTranscriptTools } from "./transcripts.js";

/** A catalog older than this is rebuilt even when the configs are unchanged: servers add tools. */
export const CATALOG_TTL_MS = 24 * 60 * 60_000;

/** The hook spawns a refresh at most this often per part, however stale it is. A running refresh keeps its lock fresh. */
export const SPAWN_INTERVAL_MS = 10 * 60_000;

/**
 * The catalog is two files so projects do not invalidate each other: `user`
 * (user-scope servers plus transcript names) is shared, `project` (local-scope
 * and approved `.mcp.json` servers) is keyed by project directory.
 */
export type Part = "user" | "project";

export interface CatalogFile {
  builtAt: number;
  fingerprint: string;
  tools: ToolEntry[];
  /** Project part only: normalized server names switched off for the project. */
  disabled?: string[];
}

export interface CatalogOptions {
  home?: string;
  projectDir: string;
  /** Where the catalog files live. Defaults to DATA_DIR. */
  cacheDir?: string;
  now?: () => number;
}

const projectKey = (projectDir: string): string => createHash("sha1").update(projectDir).digest("hex").slice(0, 12);

const fileName = (part: Part, projectDir: string): string =>
  part === "user" ? "tool-catalog.json" : `tool-catalog-${projectKey(projectDir)}.json`;

const lockFile = (cacheDir: string, part: Part, projectDir: string): string =>
  join(cacheDir, fileName(part, projectDir).replace(/\.json$/, ".lock"));

export async function readCatalogFile(cacheDir: string, part: Part, projectDir: string): Promise<CatalogFile | null> {
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, fileName(part, projectDir)), "utf-8")) as Partial<CatalogFile>;
    return typeof parsed.builtAt === "number" && typeof parsed.fingerprint === "string" && Array.isArray(parsed.tools)
      ? (parsed as CatalogFile)
      : null;
  } catch {
    return null;
  }
}

export function isCatalogStale(cached: CatalogFile | null, fingerprint: string, now: number): boolean {
  return !cached || cached.fingerprint !== fingerprint || now - cached.builtAt > CATALOG_TTL_MS;
}

export interface BuildSummary {
  part: Part;
  catalog: CatalogFile;
  servers: number;
  live: number;
  fallback: number;
}

interface BuildDeps {
  lister?: ToolLister;
  scanTranscripts?: typeof scanTranscriptTools;
}

/** Live `tools/list` first; for the user part, transcript names fill in for servers that did not answer live. */
export async function buildPart(part: Part, opts: CatalogOptions & BuildDeps): Promise<BuildSummary> {
  const home = opts.home ?? homedir();
  const configs = await discoverMcpConfigs({ home, projectDir: opts.projectDir });
  const servers = part === "user" ? configs.user : configs.project;
  const live = await listAllServers(servers, opts.lister);
  const fallback =
    part === "user"
      ? await (opts.scanTranscripts ?? scanTranscriptTools)({
          home,
          projectDir: opts.projectDir,
          exclude: live.listed,
          configured: new Set(configs.user.map((s) => normalizeServerName(s.name))),
        })
      : [];
  const catalog: CatalogFile = {
    builtAt: (opts.now ?? Date.now)(),
    fingerprint: fingerprintConfigs(servers, part === "project" ? configs.disabled : []),
    tools: [...live.tools, ...fallback],
    ...(part === "project" ? { disabled: configs.disabled } : {}),
  };
  return { part, catalog, servers: live.listed.size, live: live.tools.length, fallback: fallback.length };
}

/** Builds and persists the given parts (both by default). Never throws; a failed write only costs the next hook another spawn attempt. */
export async function refreshCatalog(
  opts: CatalogOptions & BuildDeps,
  parts: Part[] = ["user", "project"]
): Promise<BuildSummary[]> {
  const dir = opts.cacheDir ?? DATA_DIR;
  const out: BuildSummary[] = [];
  for (const part of parts) {
    const summary = await buildPart(part, opts);
    try {
      await writeFileAtomic(join(dir, fileName(part, opts.projectDir)), JSON.stringify(summary.catalog));
    } catch {
      // Unwritable cache dir → nothing to persist.
    }
    out.push(summary);
  }
  return out;
}

/** A takeover claim older than this belongs to a crashed claimer and is discarded. */
const CLAIM_TTL_MS = 30_000;

/**
 * Claims the right to spawn a refresh of one part. The lock file is created
 * exclusively (`wx`), so two hooks cannot both win a fresh slot. An existing
 * lock blocks until its mtime is {@link SPAWN_INTERVAL_MS} old (a refresh keeps
 * it fresh with {@link touchLock}, so a crashed one frees the slot after the
 * interval). Replacing a stale lock goes through a second exclusive file, so
 * one racer at a time removes it and re-checks that nobody beat them to it.
 */
export async function claimRefreshSlot(cacheDir: string, part: Part, projectDir: string, now: number): Promise<boolean> {
  const lock = lockFile(cacheDir, part, projectDir);
  const claim = `${lock}.claim`;
  const fresh = async (): Promise<boolean | "missing"> => {
    try {
      return now - (await stat(lock)).mtimeMs < SPAWN_INTERVAL_MS;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw err;
    }
  };
  let holdsClaim = false;
  try {
    await mkdir(cacheDir, { recursive: true });
    if ((await fresh()) === true) return false;
    if ((await fresh()) !== "missing") {
      try {
        await (await open(claim, "wx")).close();
        holdsClaim = true;
      } catch {
        // Someone else is replacing it — unless that claimer died long ago.
        if (Date.now() - (await stat(claim).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > CLAIM_TTL_MS) await rm(claim, { force: true });
        return false;
      }
      if ((await fresh()) === true) return false;
      await rm(lock, { force: true });
    }
    const handle = await open(lock, "wx");
    await handle.writeFile(`${process.pid}:${now}`);
    await handle.close();
    await utimes(lock, new Date(now), new Date(now));
    return true;
  } catch {
    return false;
  } finally {
    if (holdsClaim) await rm(claim, { force: true }).catch(() => {});
  }
}

/** Marks a running refresh as alive so the hook does not spawn a second one. Best effort. */
export async function touchLock(cacheDir: string, part: Part, projectDir: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(lockFile(cacheDir, part, projectDir), now, now);
  } catch {
    // No lock (e.g. a manual refresh) → nothing to keep alive.
  }
}

/** argv for re-invoking this CLI: a compiled binary is its own CLI, `bun script.ts` needs the script path too. */
export function refreshCommand(
  parts: Part[] = ["user", "project"],
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1]
): string[] {
  const viaBun = /^bun(\.exe)?$/.test(basename(execPath)) && script;
  const base = viaBun ? [execPath, script] : [execPath];
  return [...base, "tool-catalog", "refresh", ...parts.map((p) => `--${p}`)];
}

function spawnRefresh(parts: Part[]): void {
  const child = Bun.spawn(refreshCommand(parts), { stdio: ["ignore", "ignore", "ignore"], detached: true });
  child.unref();
}

/** User tools minus servers the project overrides or disabled, plus the project's own. */
export function mergeCatalogs(user: CatalogFile | null, project: CatalogFile | null): ToolEntry[] {
  const overridden = new Set([...(project?.tools ?? []).map((t) => t.server), ...(project?.disabled ?? [])]);
  const seen = new Set<string>();
  return [...(user?.tools ?? []).filter((t) => !overridden.has(t.server)), ...(project?.tools ?? [])].filter(
    (t) => !seen.has(t.name) && seen.add(t.name)
  );
}

/** The merged tool list straight from the cache files, with no staleness check and no spawn. */
export async function readMergedCatalog(opts: CatalogOptions): Promise<ToolEntry[]> {
  const cacheDir = opts.cacheDir ?? DATA_DIR;
  const [user, project] = await Promise.all([
    readCatalogFile(cacheDir, "user", opts.projectDir),
    readCatalogFile(cacheDir, "project", opts.projectDir),
  ]);
  return mergeCatalogs(user, project);
}

/**
 * The hook's view of the catalog: reads the cached parts only. For each part
 * that is missing or stale it claims the spawn slot, and kicks off ONE
 * detached `tool-catalog refresh` for the claimed parts, without waiting.
 * Returns whatever the old cache holds. Never throws.
 */
export async function loadCatalogForHook(opts: CatalogOptions & { spawn?: (parts: Part[]) => void }): Promise<ToolEntry[]> {
  try {
    const cacheDir = opts.cacheDir ?? DATA_DIR;
    const now = (opts.now ?? Date.now)();
    const [user, configs] = await Promise.all([
      readCatalogFile(cacheDir, "user", opts.projectDir),
      discoverMcpConfigs({ home: opts.home, projectDir: opts.projectDir }),
    ]);
    // A directory with no project-scoped servers (no local-scope entry, no approved .mcp.json)
    // has no project part: no file is read and no refresh is spawned for it.
    const hasProject = configs.project.length > 0 || configs.disabled.length > 0;
    const project = hasProject ? await readCatalogFile(cacheDir, "project", opts.projectDir) : null;
    const stale: Part[] = [];
    if (isCatalogStale(user, fingerprintConfigs(configs.user), now)) stale.push("user");
    if (hasProject && isCatalogStale(project, fingerprintConfigs(configs.project, configs.disabled), now)) stale.push("project");
    const claimed: Part[] = [];
    for (const part of stale) if (await claimRefreshSlot(cacheDir, part, opts.projectDir, now)) claimed.push(part);
    if (claimed.length > 0) (opts.spawn ?? spawnRefresh)(claimed);
    return mergeCatalogs(user, project);
  } catch {
    return [];
  }
}
