// `update` subcommand — updates project-brain to the latest published
// version via the install manager it was originally installed with (bun,
// pnpm, yarn, or npm). Complements the passive notifier (src/notifier.ts),
// which only prints the command; this one runs it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, VERSION } from "../constants.js";
import { detectInstallManager, isNewer, resolveBinPath, updateCommand, type InstallManager } from "../notifier.js";
import { fetchLatestVersion } from "./update-check.js";

export interface UpdateDeps {
  currentVersion: string;
  binPath: string;
  env: Record<string, string | undefined>;
  fetchLatest: () => Promise<string | null>;
  spawnUpdate: (argv: string[]) => Promise<number>;
  log: (message: string) => void;
  /** Skip the install; only re-apply setup (for upgrades done by brew/npm directly). */
  applyOnly?: boolean;
  /**
   * Runs the NEWLY installed binary's `setup --apply-saved`. A separate process on purpose: this one
   * is still the old code, and the new units/skills live in the new binary.
   */
  applySetup?: () => Promise<number>;
  /** What the installed binary reports for `--version`; null when it cannot be run. */
  installedVersion?: () => Promise<string | null>;
  hasSavedSelection?: () => boolean;
}

export interface UpdateResult {
  alreadyLatest: boolean;
  current: string;
  latest: string | null;
  manager: InstallManager;
  exitCode: number | null;
  setupExitCode?: number | null;
}

async function reapplySetup(deps: UpdateDeps, expected: string | null): Promise<number | null> {
  if (!deps.applySetup) return null;
  // The install manager may have written somewhere other than the binary we would spawn (a second copy
  // earlier on PATH): applying the OLD binary's units would quietly do nothing useful, so check first.
  if (deps.installedVersion) {
    const found = await deps.installedVersion();
    const ok = found !== null && (expected ? found === expected : deps.applyOnly || isNewer(found, deps.currentVersion));
    if (!ok) {
      deps.log(
        `The project-brain on your PATH reports ${found ?? "no version"}${expected ? `, expected ${expected}` : ""}; setup was not re-applied.\n` +
          "  Once it is current, run `project-brain update --apply-only`."
      );
      return null;
    }
  }
  deps.log("Re-applying your setup with the new version...");
  const code = await deps.applySetup().catch(() => 1);
  if (code !== 0) deps.log(`Setup re-apply did not finish (exit ${code}). Run \`project-brain setup\` to retry.`);
  else if (deps.hasSavedSelection && !deps.hasSavedSelection())
    deps.log("No saved setup selection: only what is already installed was refreshed. Run `project-brain setup` to add more.");
  return code;
}

/** Core, fully-injectable update logic. */
export async function runUpdate(deps: UpdateDeps): Promise<UpdateResult> {
  const manager = detectInstallManager(deps.binPath, deps.env);

  if (deps.applyOnly) {
    const setupExitCode = await reapplySetup(deps, null);
    return { alreadyLatest: false, current: deps.currentVersion, latest: null, manager, exitCode: null, setupExitCode };
  }

  const command = updateCommand(manager);

  // A channel we cannot drive. Running a guessed command here would install a
  // second copy that shadows the real one, so say what we know and stop.
  if (command === null) {
    deps.log(
      `project-brain ${deps.currentVersion} was not installed by a package manager this command can drive.\n` +
        `  Update it the way you installed it — re-run your installer, or replace the binary.`
    );
    return {
      alreadyLatest: false,
      current: deps.currentVersion,
      latest: null,
      manager,
      exitCode: null,
    };
  }

  const argv = command.split(" ");

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
  const setupExitCode = exitCode === 0 ? await reapplySetup(deps, latest) : null;
  return { alreadyLatest: false, current: deps.currentVersion, latest, manager, exitCode, setupExitCode };
}

async function defaultSpawnUpdate(argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

/** Where the install manager puts the `project-brain` bin, when it is knowable without running it. */
export function managerBin(
  manager: InstallManager,
  env: Record<string, string | undefined>,
  home: string = homedir()
): string | null {
  if (manager === "bun") return join(env.BUN_INSTALL ?? join(home, ".bun"), "bin", "project-brain");
  if (manager === "pnpm" && env.PNPM_HOME) return join(env.PNPM_HOME, "project-brain");
  return null;
}

/** argv that runs the installed binary as a CLI: where the manager installed it, else the PATH shim, else this script under bun. */
export function installedCliArgv(
  preferred: string | null = null,
  which: (name: string) => string | null = Bun.which,
  execPath: string = process.execPath,
  script: string | undefined = process.argv[1],
  exists: (p: string) => boolean = existsSync
): string[] {
  if (preferred && exists(preferred)) return [preferred];
  const installed = which("project-brain");
  if (installed) return [installed];
  const viaBun = /^bun(\.exe)?$/.test(execPath.split(/[\\/]/).pop() ?? "") && script;
  return viaBun ? [execPath, script] : [execPath];
}

async function defaultInstalledVersion(cli: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([...cli, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? (/\d+\.\d+\.\d+\S*/.exec(out)?.[0] ?? null) : null;
  } catch {
    return null;
  }
}

async function defaultApplySetup(cli: string[]): Promise<number> {
  const proc = Bun.spawn([...cli, "setup", "--apply-saved"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BRAIN_NO_UPDATE_CHECK: "1" },
  });
  return await proc.exited;
}

/** CLI entry point for the `update` command. */
export async function execute(args: string[]): Promise<void> {
  const binPath = resolveBinPath();
  const cli = installedCliArgv(managerBin(detectInstallManager(binPath, process.env), process.env));
  const result = await runUpdate({
    currentVersion: VERSION,
    binPath,
    env: process.env,
    fetchLatest: fetchLatestVersion,
    spawnUpdate: defaultSpawnUpdate,
    log: (m) => console.log(m),
    applyOnly: args.includes("--apply-only"),
    applySetup: () => defaultApplySetup(cli),
    installedVersion: () => defaultInstalledVersion(cli),
    hasSavedSelection: () => existsSync(join(DATA_DIR, "setup-selection.json")),
  });

  if (!result.alreadyLatest && result.exitCode !== 0) {
    console.error(`Update failed (exit code ${result.exitCode}). Try running manually: ${updateCommand(result.manager)}`);
    process.exit(result.exitCode ?? 1);
  }
}
