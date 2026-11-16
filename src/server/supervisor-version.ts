// Whether the binary on disk is still the one this server process runs.
//
// A stdio server lives as long as its Claude Code session, so `brew upgrade` leaves it serving the
// old code for days. check_health asks this so the answer can name both versions and the fix.
import { DATA_DIR, VERSION } from "../constants.js";
import { isNewer } from "../notifier.js";
import { launcherSignature, probeLauncherVersion, resolveLauncher, type Launcher } from "./supervisor.js";

export interface InstalledVersion {
  /** Absent when the installed binary does not start; versionDrift then says why. */
  installedVersion?: string;
  /** Present only when something needs doing: an older server, or an installed binary that does not start. */
  versionDrift?: string;
}

export type InstalledVersionProbe = () => Promise<InstalledVersion | null>;

export interface SwapFailureNote {
  to: string;
  reason: string;
  kind?: "start" | "protocol" | "idle";
}

export interface ProbeOptions {
  launcher?: Launcher;
  running?: string;
  /** Run by the hot-swap supervisor (`serve --worker`), which moves to a newer binary on its own. */
  supervised?: boolean;
  /** Simplified reader for tests: null stands for "printed no project-brain version". */
  readVersion?: (launcher: Launcher) => Promise<string | null>;
  probeVersion?: (launcher: Launcher) => Promise<{ version: string } | { error: string }>;
  /** The supervisor's last abandoned swap, if any. Defaults to the record its supervisor left. */
  swapFailure?: () => Promise<SwapFailureNote | null>;
}

/** Reconnecting would start the same broken binary, so the advice is to reinstall, not to reconnect. */
export function describeBroken(binary: string, version: string | null, reason: string, running: string): string {
  const what = version ? `The installed project-brain ${version} (${binary})` : `The installed project-brain (${binary})`;
  return `${what} fails to start: ${reason}. This session keeps working on ${running}; reinstall project-brain or upgrade again.`;
}

/** Only an older server is drift: a newer one (run from source) would go back in time on reconnect. */
export function describeDrift(
  running: string,
  installed: string,
  supervised: boolean,
  failure: SwapFailureNote | null = null,
  binary = "on PATH"
): string | undefined {
  if (!isNewer(installed, running)) return undefined;
  const head = `MCP server runs ${running}, installed ${installed}`;
  if (supervised && failure?.to === installed) {
    if (failure.kind === "protocol" || failure.kind === "idle")
      return `${head}: the hot swap to it did not happen (${failure.reason}); run /mcp reconnect to load it`;
    return describeBroken(binary, installed, failure.reason, running);
  }
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
  const readVersion = opts.readVersion;
  const probeVersion =
    opts.probeVersion ??
    (readVersion
      ? async (l: Launcher) => {
          const version = await readVersion(l);
          return version === null ? { error: "--version printed no project-brain version" } : { version };
        }
      : probeLauncherVersion);
  const supervisorPid = Number(process.env.BRAIN_CLIENT_PID);
  const swapFailure =
    opts.swapFailure ??
    (async () => (supervised && supervisorPid ? (await import("../hooks/session-versions.js")).readSwapFailure(DATA_DIR, supervisorPid) : null));
  const baseline = launcherSignature(launcher.watch);
  // Per signature, failures included: a binary that hangs on --version costs that wait once, not per call.
  let known: { signature: string; result: { version: string } | { error: string } } | null = null;

  return async () => {
    const signature = launcherSignature(launcher.watch);
    if (baseline === null || signature === null) return null;
    let installed = running;
    if (signature !== baseline) {
      if (known?.signature !== signature) known = { signature, result: await probeVersion(launcher) };
      if ("error" in known.result) return { versionDrift: describeBroken(launcher.watch, null, known.result.error, running) };
      installed = known.result.version;
    }
    const failure = supervised && isNewer(installed, running) ? await swapFailure().catch(() => null) : null;
    const versionDrift = describeDrift(running, installed, supervised, failure, launcher.watch);
    return { installedVersion: installed, ...(versionDrift ? { versionDrift } : {}) };
  };
}
