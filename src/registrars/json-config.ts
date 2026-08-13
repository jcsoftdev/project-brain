import { dirname } from "node:path";
import { mkdir, stat, rename, unlink } from "node:fs/promises";

/** Windows-safe directory check (no POSIX `test` binary — review finding). */
export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Thrown when a config file exists but its content isn't valid JSON (e.g. a
 * mid-edit trailing comma, or JSONC with comments — comments are valid in
 * Zed/VS Code settings but not in JSON.parse). We deliberately do NOT attempt
 * JSONC parsing/rewriting here: even a successful JSONC parse would strip the
 * user's comments on re-serialize, which is itself a form of config loss.
 */
export class UnparseableConfigError extends Error {
  constructor(
    public readonly configPath: string,
    cause: unknown
  ) {
    super(
      `Config file at ${configPath} exists but is not valid JSON — refusing to overwrite it. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
    this.name = "UnparseableConfigError";
  }
}

/**
 * Read-or-init a JSON config, apply a mutation, write it back (pretty, 2-space).
 *
 * - File absent → start from {} (normal first-run case).
 * - File exists but unparseable → throws UnparseableConfigError and NEVER
 *   writes, so a user's mid-edit/JSONC config is never destroyed.
 * - Write is atomic: written to a sibling tmp file then renamed over the
 *   target, so a crash mid-write can't corrupt the config either.
 */
export async function upsertJsonConfig(
  configPath: string,
  mutate: (config: Record<string, any>) => void
): Promise<void> {
  let config: Record<string, any> = {};

  let raw: string | undefined;
  try {
    raw = await Bun.file(configPath).text();
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    raw = undefined; // absent → start fresh with {}
  }

  if (raw !== undefined) {
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new UnparseableConfigError(configPath, err);
    }
  }

  mutate(config);
  await mkdir(dirname(configPath), { recursive: true });

  const tmpPath = `${configPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await Bun.write(tmpPath, JSON.stringify(config, null, 2));
    await rename(tmpPath, configPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Entrypoints bun must interpret. Anything else is a compiled executable. */
const SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * How a host should spawn the MCP server for a given resolved server path.
 *
 * Two shapes reach this function, and they must be launched differently:
 *
 * - A source entrypoint (`src/cli.ts`, the dev fallback) is JavaScript/TypeScript
 *   and needs the bun runtime in front of it.
 * - An installed `project-brain` (Homebrew, or any `bun build --compile` output)
 *   is a native executable. Prefixing THAT with bun makes bun parse the Mach-O/ELF
 *   header as source and exit immediately — which every MCP client surfaces only
 *   as the useless `CONNECTION_CLOSED`.
 *
 * Since `Bun.which("project-brain")` is the primary branch in setup, the second
 * case is what nearly every installed user gets.
 */
export function launchCommand(serverPath: string): {
  command: string;
  args: string[];
} {
  const lower = serverPath.toLowerCase();
  const isScript = SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  return isScript
    ? { command: "bun", args: [serverPath] }
    : { command: serverPath, args: [] };
}

/** The standard mcpServers entry every JSON-config registrar writes. */
export function standardServerEntry(serverPath: string): Record<string, unknown> {
  const { command, args } = launchCommand(serverPath);
  return { command, args, transport: "stdio" };
}
