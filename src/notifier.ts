// Update notifier — warns the user when a newer project-brain is published.
//
// Design: ZERO latency in the hot path. checkForUpdate() only READS a cached
// result (instant, no network) and prints a one-line notice if a newer version
// is known. When the cache is stale/missing it spawns a DETACHED copy of the CLI
// (`__update-check`) that refreshes the cache for the NEXT run, then unrefs so the
// current command exits immediately. Fully fail-silent — a broken cache, no
// network, or a spawn failure never affects the command being run.
//
// Opt out with BRAIN_NO_UPDATE_CHECK=1.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, VERSION } from "./constants.js";

export const UPDATE_CACHE_FILE = join(DATA_DIR, "update-check.json");
const STALE_MS = 24 * 60 * 60 * 1000; // re-check at most once a day

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

/**
 * True when `latest` is a strictly higher release than `current`.
 * Compares numeric major.minor.patch only; a prerelease of the same base
 * (e.g. 0.6.0-beta.1 vs 0.6.0) is NOT considered newer, and any unparseable
 * input is fail-safe (returns false).
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

export type InstallManager = "bun" | "pnpm" | "yarn" | "npm";

/**
 * Pure detection of the install manager from the running binary's path.
 * No fs/process access — caller resolves binPath (e.g. via realpath) and
 * passes in env explicitly.
 */
export function detectInstallManager(
  binPath: string,
  env: Record<string, string | undefined>
): InstallManager {
  const normalized = binPath.replace(/\\/g, "/");

  if (normalized.includes(".bun/bin") || normalized.includes(".bun/install/global")) {
    return "bun";
  }

  const pnpmHome = env.PNPM_HOME?.replace(/\\/g, "/");
  if (pnpmHome && normalized.startsWith(pnpmHome)) {
    return "pnpm";
  }
  if (/(^|\/)pnpm(\/|$)/.test(normalized)) {
    return "pnpm";
  }

  if (normalized.includes(".yarn/bin") || normalized.includes("yarn/global")) {
    return "yarn";
  }

  return "npm";
}

/** Update command for the given install manager. */
export function updateCommand(manager: InstallManager): string {
  switch (manager) {
    case "bun":
      return "bun add -g project-brain@latest";
    case "pnpm":
      return "pnpm add -g project-brain@latest";
    case "yarn":
      return "yarn global add project-brain@latest";
    case "npm":
      return "npm install -g project-brain@latest";
  }
}

export interface NotifierDeps {
  currentVersion: string;
  now: () => number;
  readCache: () => UpdateCache | null;
  warn: (message: string) => void;
  refresh: () => void;
  staleMs: number;
  optedOut: boolean;
  updateCmd: string;
}

/** Pure, fully-injectable core. Never throws. */
export function checkForUpdate(deps: NotifierDeps): void {
  if (deps.optedOut) return;

  let cache: UpdateCache | null = null;
  try {
    cache = deps.readCache();
  } catch {
    cache = null;
  }

  if (cache?.latest && isNewer(cache.latest, deps.currentVersion)) {
    try {
      deps.warn(
        `\n  project-brain update available: ${deps.currentVersion} → ${cache.latest}\n` +
          `  Run: ${deps.updateCmd}\n`
      );
    } catch {
      /* fail-silent */
    }
  }

  if (!cache || deps.now() - cache.checkedAt > deps.staleMs) {
    try {
      deps.refresh();
    } catch {
      /* fail-silent */
    }
  }
}

function readCacheFile(): UpdateCache | null {
  const raw = readFileSync(UPDATE_CACHE_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<UpdateCache>;
  if (typeof parsed.latest === "string" && typeof parsed.checkedAt === "number") {
    return { latest: parsed.latest, checkedAt: parsed.checkedAt };
  }
  return null;
}

/** Spawn a detached `__update-check` to refresh the cache for the next run. */
function spawnRefresh(): void {
  // In the shipped compiled binary, process.execPath IS the CLI, so re-invoking
  // it with the hidden subcommand works. In dev (bun run) this may no-op; that's
  // fine — the notifier is best-effort and fail-silent.
  const child = spawn(process.execPath, ["__update-check"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** Resolve the true install location of the running binary, fail-silent to the raw path. */
function resolveBinPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Default wrapper wired to the real filesystem, registry, and process. */
export function notifyIfUpdateAvailable(): void {
  const manager = detectInstallManager(resolveBinPath(), process.env);
  checkForUpdate({
    currentVersion: VERSION,
    now: () => Date.now(),
    readCache: readCacheFile,
    warn: (m) => process.stderr.write(m),
    refresh: spawnRefresh,
    staleMs: STALE_MS,
    optedOut: process.env.BRAIN_NO_UPDATE_CHECK === "1" || process.env.CI === "true",
    updateCmd: updateCommand(manager),
  });
}
