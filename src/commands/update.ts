// `update` subcommand — updates project-brain to the latest published
// version via the install manager it was originally installed with (bun,
// pnpm, yarn, or npm). Complements the passive notifier (src/notifier.ts),
// which only prints the command; this one runs it.
import { VERSION } from "../constants.js";
import { detectInstallManager, isNewer, resolveBinPath, updateCommand, type InstallManager } from "../notifier.js";
import { fetchLatestVersion } from "./update-check.js";

export interface UpdateDeps {
  currentVersion: string;
  binPath: string;
  env: Record<string, string | undefined>;
  fetchLatest: () => Promise<string | null>;
  spawnUpdate: (argv: string[]) => Promise<number>;
  log: (message: string) => void;
}

export interface UpdateResult {
  alreadyLatest: boolean;
  current: string;
  latest: string | null;
  manager: InstallManager;
  exitCode: number | null;
}

/** Core, fully-injectable update logic. */
export async function runUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const manager = detectInstallManager(deps.binPath, deps.env);
  const argv = updateCommand(manager).split(" ");

  const latest = await deps.fetchLatest().catch(() => null);

  if (latest && !isNewer(latest, deps.currentVersion)) {
    deps.log(`project-brain is already up to date (${deps.currentVersion}).`);
    return { alreadyLatest: true, current: deps.currentVersion, latest, manager, exitCode: null };
  }

  deps.log(
    latest
      ? `Updating project-brain: ${deps.currentVersion} → ${latest}\n  Running: ${argv.join(" ")}\n`
      : `Updating project-brain (could not check the latest published version — running anyway)\n  Running: ${argv.join(" ")}\n`
  );

  const exitCode = await deps.spawnUpdate(argv);
  return { alreadyLatest: false, current: deps.currentVersion, latest, manager, exitCode };
}

async function defaultSpawnUpdate(argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

/** CLI entry point for the `update` command. */
export async function execute(_args: string[]): Promise<void> {
  const result = await runUpdate({
    currentVersion: VERSION,
    binPath: resolveBinPath(),
    env: process.env,
    fetchLatest: fetchLatestVersion,
    spawnUpdate: defaultSpawnUpdate,
    log: (m) => console.log(m),
  });

  if (!result.alreadyLatest && result.exitCode !== 0) {
    console.error(`Update failed (exit code ${result.exitCode}). Try running manually: ${updateCommand(result.manager)}`);
    process.exit(result.exitCode ?? 1);
  }
}
