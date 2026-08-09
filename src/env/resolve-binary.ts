import { join } from "node:path";
import { homedir } from "node:os";
import { access, stat, readdir } from "node:fs/promises";
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
  /**
   * Editor extension roots to scan, relative to `home`. Injectable for the same
   * reason as systemDirs. Pass [] to disable the scan entirely.
   */
  extensionRoots?: string[][];
}

const DEFAULT_SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Editor extension roots, relative to home.
 *
 * An agent CLI is not always a CLI. The OpenAI ChatGPT extension ships `codex`
 * *inside the extension directory* — never on PATH, never under ~/.codex/bin —
 * so every fixed-directory lookup reports the tool absent while the user is
 * actively using it. The cost of that false negative is silent: an undetected
 * tool never registers, never enters registeredTools, and therefore never
 * receives skills.
 */
const DEFAULT_EXTENSION_ROOTS = [
  [".vscode", "extensions"],
  [".vscode-insiders", "extensions"],
  [".cursor", "extensions"],
  [".trae", "extensions"],
  [".windsurf", "extensions"],
];

/**
 * Look for `<root>/<extension>/bin/<name>` and `<root>/<extension>/bin/<arch>/<name>`.
 *
 * Two levels deep and no further, on purpose: extension trees are large and a
 * setup command must not turn into a filesystem crawl. The arch level exists
 * because vendors ship every platform in one universal package —
 * `openai.chatgpt-0.4.76-universal/bin/macos-aarch64/codex`.
 *
 * Every read is guarded: an unreadable extension directory is a reason to keep
 * looking, never a reason to fail the caller.
 */
async function scanExtensionRoots(
  home: string,
  name: string,
  roots: string[][]
): Promise<string | null> {
  for (const parts of roots) {
    const root = join(home, ...parts);
    let extensions: string[];
    try {
      extensions = await readdir(root);
    } catch {
      continue; // editor not installed — expected, not exceptional
    }

    for (const ext of extensions) {
      const binDir = join(root, ext, "bin");
      const direct = join(binDir, name);
      if (await isExecutableFile(direct)) return direct;

      let archDirs: string[];
      try {
        archDirs = await readdir(binDir);
      } catch {
        continue; // extension without a bin/ — the common case
      }
      for (const arch of archDirs) {
        const candidate = join(binDir, arch, name);
        if (await isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

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
 * shell profile may never have exported, then inside editor extensions.
 *
 * The extension scan runs last because it is the only step that lists
 * directories rather than stat-ing a known path — cheap in practice (it exits
 * on the first missing root) but not free, so the fixed lookups get first
 * refusal.
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

  return scanExtensionRoots(home, name, options.extensionRoots ?? DEFAULT_EXTENSION_ROOTS);
}
