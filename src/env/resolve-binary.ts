import { join } from "node:path";
import { homedir } from "node:os";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";

export interface ResolveBinaryOptions {
  /** Home directory to search under. Defaults to the real one. */
  home?: string;
  /** PATH lookup. Injectable so tests can simulate an empty PATH. */
  which?: (name: string) => string | null;
  /**
   * Machine-wide directories to search after the home-relative ones. Injectable
   * because they exist on the developer's own machine: a test that asserts
   * "not found" would otherwise pick up a real installation and fail.
   */
  systemDirs?: string[];
}

const DEFAULT_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Directories a CLI may live in without being on PATH, in search order.
 *
 * Vendor shell installers routinely land here: Claude Code's native installer
 * writes ~/.local/bin/<name> and appends the PATH export to ~/.profile, which
 * zsh does not read — so the binary exists, works when invoked by its own
 * absolute path, and is invisible to `Bun.which` in any zsh-launched process.
 * Homebrew's paths are included because a GUI-launched process inherits a PATH
 * that predates any shell profile.
 */
function candidateDirs(home: string, name: string, systemDirs: string[]): string[] {
  return [
    join(home, ".local", "bin"),
    // Claude Code's older per-user install location.
    join(home, ".claude", "local"),
    // Tools that install under their own dot-directory, e.g. ~/.codex/bin.
    join(home, `.${name}`, "bin"),
    join(home, ".bun", "bin"),
    ...systemDirs,
  ];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    // A directory can satisfy access(X_OK) — "executable" means traversable
    // there — so the stat check is what actually rules one out.
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate a CLI binary: PATH first, then the well-known install directories a
 * shell profile may never have exported.
 *
 * Returns the absolute path, or null when the tool is genuinely absent.
 */
export async function resolveBinary(
  name: string,
  options: ResolveBinaryOptions = {}
): Promise<string | null> {
  const which = options.which ?? ((n: string) => Bun.which(n));
  const onPath = which(name);
  if (onPath) return onPath;

  const home = options.home ?? homedir();
  const systemDirs = options.systemDirs ?? DEFAULT_SYSTEM_DIRS;
  for (const dir of candidateDirs(home, name, systemDirs)) {
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}
