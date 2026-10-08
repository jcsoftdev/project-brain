import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ARCH_CONFIG_PATH, GLOBAL_ARCH_CONFIG_NAME, HEXAGONAL_PRESET } from "../arch/config.js";
import { findProjectRoot } from "./resolve-project.js";

export type ArchInitResult = "written" | "exists";

async function writePreset(path: string, force: boolean): Promise<ArchInitResult> {
  if (existsSync(path) && !force) return "exists";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(HEXAGONAL_PRESET, null, 2)}\n`);
  return "written";
}

/** Pins the preset in one project, where it overrides the global default. Refuses to overwrite an edited file unless forced. */
export function initArchConfig(root: string, options: { force?: boolean } = {}): Promise<ArchInitResult> {
  return writePreset(join(root, ARCH_CONFIG_PATH), options.force === true);
}

/** Path of the machine-wide default inside a data directory. */
export function globalArchConfigPath(dataDir: string): string {
  return join(dataDir, GLOBAL_ARCH_CONFIG_NAME);
}

/** Seeds the global default once and never touches it again: the user may have edited it. */
export function initGlobalArchConfig(dataDir: string): Promise<ArchInitResult> {
  return writePreset(globalArchConfigPath(dataDir), false);
}

const USAGE = "Usage: project-brain arch init [--force]   (pin a per-project config; overrides the global default)";

export async function execute(args: string[]): Promise<void> {
  if (args[0] !== "init") {
    console.error(USAGE);
    process.exit(1);
  }

  const root = findProjectRoot() ?? process.cwd();
  const result = await initArchConfig(root, { force: args.includes("--force") });
  if (result === "exists") {
    console.error(`${ARCH_CONFIG_PATH} already exists. Re-run with --force to overwrite it.`);
    process.exit(1);
  }
  console.log(`Wrote ${join(root, ARCH_CONFIG_PATH)} (hexagonal preset, mode "warn").`);
  console.log("This per-project file overrides the global default; it is optional, the guard works without it.");
  console.log('Edit the layer globs to match your tree, then set "mode": "block" to enforce (anything else only warns).');
  console.log("Enforcement needs the hook: project-brain setup --with=hooks:arch-guard");
}
