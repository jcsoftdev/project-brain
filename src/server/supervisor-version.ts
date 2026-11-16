// Whether the binary on disk is still the one this server process runs.
//
// A stdio server lives as long as its Claude Code session, so `brew upgrade` leaves it serving the
// old code for days. check_health asks this so the answer can name both versions and the fix.
import { VERSION } from "../constants.js";
import { isNewer } from "../notifier.js";
import { launcherSignature, readLauncherVersion, resolveLauncher, type Launcher } from "./supervisor.js";

export interface InstalledVersion {
  installedVersion: string;
  /** Present only when the installed binary is newer than the running server: both versions and the fix. */
  versionDrift?: string;
}

export type InstalledVersionProbe = () => Promise<InstalledVersion | null>;

export interface ProbeOptions {
  launcher?: Launcher;
  running?: string;
  /** Run by the hot-swap supervisor (`serve --worker`), which moves to a newer binary on its own. */
  supervised?: boolean;
  readVersion?: (launcher: Launcher) => Promise<string | null>;
}

/** Only an older server is drift: a newer one (run from source) would go back in time on reconnect. */
export function describeDrift(running: string, installed: string, supervised: boolean): string | undefined {
  if (!isNewer(installed, running)) return undefined;
  const head = `MCP server runs ${running}, installed ${installed}`;
  if (supervised)
    return `${head}: the hot swap moves this session to it at the next idle moment; if this persists, run /mcp reconnect`;
  return `${head}: run /mcp reconnect (or restart Claude Code) to load it`;
}

/**
 * Create at server startup: the launcher's signature is taken now, so an unchanged file answers
 * without spawning anything and only a changed one costs a `--version` run. Null when the launcher
 * cannot be read (a test runner, an install still being written).
 */
export function installedVersionProbe(opts: ProbeOptions = {}): InstalledVersionProbe {
  const launcher = opts.launcher ?? resolveLauncher();
  const running = opts.running ?? VERSION;
  const supervised = opts.supervised ?? process.argv.includes("--worker");
  const readVersion = opts.readVersion ?? readLauncherVersion;
  const baseline = launcherSignature(launcher.watch);
  // Per signature, failures included: a binary that hangs on --version costs that wait once, not per call.
  let known: { signature: string; version: string | null } | null = null;

  return async () => {
    const signature = launcherSignature(launcher.watch);
    if (baseline === null || signature === null) return null;
    let installed = running;
    if (signature !== baseline) {
      if (known?.signature !== signature) known = { signature, version: await readVersion(launcher) };
      if (known.version === null) return null;
      installed = known.version;
    }
    const versionDrift = describeDrift(running, installed, supervised);
    return { installedVersion: installed, ...(versionDrift ? { versionDrift } : {}) };
  };
}
