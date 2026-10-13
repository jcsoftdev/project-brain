import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DATA_DIR } from "../constants.js";
import { discoverMcpConfigs, fingerprintConfigs } from "./config.js";
import { listAllServers, type ToolEntry, type ToolLister } from "./live.js";
import { scanTranscriptTools } from "./transcripts.js";

/** A catalog older than this is rebuilt even when the configs are unchanged: servers add tools. */
export const CATALOG_TTL_MS = 24 * 60 * 60_000;

/** The hook spawns a refresh at most this often, however stale the catalog is. */
export const SPAWN_INTERVAL_MS = 10 * 60_000;

export interface CatalogFile {
  builtAt: number;
  fingerprint: string;
  tools: ToolEntry[];
}

export interface CatalogOptions {
  home?: string;
  projectDir: string;
  /** Where tool-catalog.json lives. Defaults to DATA_DIR. */
  cacheDir?: string;
  now?: () => number;
}

const catalogPath = (dir: string): string => join(dir, "tool-catalog.json");
const lockPath = (dir: string): string => join(dir, "tool-catalog.lock");

export async function readCatalogFile(cacheDir: string = DATA_DIR): Promise<CatalogFile | null> {
  try {
    const parsed = JSON.parse(await readFile(catalogPath(cacheDir), "utf-8")) as Partial<CatalogFile>;
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
  catalog: CatalogFile;
  servers: number;
  live: number;
  fallback: number;
}

/** Live `tools/list` first; transcript names fill in only for servers that did not answer live. */
export async function buildCatalog(
  opts: CatalogOptions & { lister?: ToolLister; scanTranscripts?: typeof scanTranscriptTools }
): Promise<BuildSummary> {
  const home = opts.home ?? homedir();
  const configs = await discoverMcpConfigs({ home, projectDir: opts.projectDir });
  const live = await listAllServers(configs, opts.lister);
  const fallback = await (opts.scanTranscripts ?? scanTranscriptTools)(live.listed, home);
  const catalog: CatalogFile = {
    builtAt: (opts.now ?? Date.now)(),
    fingerprint: fingerprintConfigs(configs),
    tools: [...live.tools, ...fallback],
  };
  return { catalog, servers: live.listed.size, live: live.tools.length, fallback: fallback.length };
}

/** Builds and persists the catalog. Never throws; a failed write only costs the next hook another spawn attempt. */
export async function refreshCatalog(
  opts: CatalogOptions & { lister?: ToolLister; scanTranscripts?: typeof scanTranscriptTools }
): Promise<BuildSummary> {
  const summary = await buildCatalog(opts);
  const dir = opts.cacheDir ?? DATA_DIR;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(catalogPath(dir), JSON.stringify(summary.catalog));
  } catch {
    // Unwritable cache dir → nothing to persist.
  }
  return summary;
}

/**
 * Claims the right to spawn a refresh: true when the last claim is older than
 * {@link SPAWN_INTERVAL_MS}. The lock file's mtime is the timestamp, so a
 * crashed refresher cannot wedge it for longer than the interval.
 */
export async function claimRefreshSlot(cacheDir: string, now: number): Promise<boolean> {
  try {
    const lock = lockPath(cacheDir);
    await mkdir(cacheDir, { recursive: true });
    try {
      if (now - (await stat(lock)).mtimeMs < SPAWN_INTERVAL_MS) return false;
    } catch {
      // No lock yet.
    }
    await writeFile(lock, String(now));
    await utimes(lock, new Date(now), new Date(now));
    return true;
  } catch {
    return false;
  }
}

/** argv for re-invoking this CLI: a compiled binary is its own CLI, `bun script.ts` needs the script path too. */
export function refreshCommand(execPath: string = process.execPath, script: string | undefined = process.argv[1]): string[] {
  const viaBun = /^bun(\.exe)?$/.test(basename(execPath)) && script;
  return viaBun ? [execPath, script, "tool-catalog", "refresh"] : [execPath, "tool-catalog", "refresh"];
}

function spawnRefresh(): void {
  const child = Bun.spawn(refreshCommand(), { stdio: ["ignore", "ignore", "ignore"] });
  child.unref();
}

/**
 * The hook's view of the catalog: reads the cache only. When it is missing or
 * stale, kicks off a detached `tool-catalog refresh` (at most once per
 * {@link SPAWN_INTERVAL_MS}) and returns whatever the old cache holds without
 * waiting. Never throws.
 */
export async function loadCatalogForHook(
  opts: CatalogOptions & { spawn?: () => void }
): Promise<ToolEntry[]> {
  try {
    const cacheDir = opts.cacheDir ?? DATA_DIR;
    const now = (opts.now ?? Date.now)();
    const cached = await readCatalogFile(cacheDir);
    const configs = await discoverMcpConfigs({ home: opts.home, projectDir: opts.projectDir });
    if (isCatalogStale(cached, fingerprintConfigs(configs), now) && (await claimRefreshSlot(cacheDir, now))) {
      (opts.spawn ?? spawnRefresh)();
    }
    return cached?.tools ?? [];
  } catch {
    return [];
  }
}
