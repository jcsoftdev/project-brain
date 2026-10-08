import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ARCH_CONFIG_PATH, HEXAGONAL_PRESET } from "../arch/config.js";
import { findProjectRoot } from "./resolve-project.js";

export type ArchInitResult = "written" | "exists";

/** Writes the hexagonal preset. Refuses to overwrite a file the user may have edited unless forced. */
export async function initArchConfig(root: string, options: { force?: boolean } = {}): Promise<ArchInitResult> {
  const path = join(root, ARCH_CONFIG_PATH);
  if (existsSync(path) && !options.force) return "exists";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(HEXAGONAL_PRESET, null, 2)}\n`);
  return "written";
}

const USAGE = "Usage: project-brain arch init [--force]";

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
  console.log('Edit the layer globs to match your tree, then set "mode": "block" to enforce (anything else only warns).');
  console.log("Enforcement needs the hook: project-brain setup --with=hooks:arch-guard");
}
