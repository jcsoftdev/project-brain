import { join } from "node:path";

/** Directories/patterns always ignored regardless of .gitignore. */
const ALWAYS_IGNORE = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "target/",
  "__pycache__/",
  ".project-brain/",
];

/**
 * Check if a file path should be ignored.
 * Uses hardcoded always-ignore list + custom patterns from .gitignore.
 */
export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  // Check always-ignore list
  for (const ignore of ALWAYS_IGNORE) {
    if (filePath.includes(ignore)) {
      return true;
    }
  }

  // Process patterns (last matching pattern wins, negation with !)
  let ignored = false;

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      // Negation pattern
      const negated = pattern.slice(1);
      if (matchPattern(filePath, negated)) {
        ignored = false;
      }
    } else if (matchPattern(filePath, pattern)) {
      ignored = true;
    }
  }

  return ignored;
}

/**
 * Load .gitignore patterns from one directory, prefixed with its relative path.
 */
async function loadPatternsFromDir(dir: string, root: string): Promise<string[]> {
  try {
    const content = await Bun.file(join(dir, ".gitignore")).text();
    const relDir = dir === root ? "" : dir.slice(root.length + 1).replace(/\\/g, "/");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((pattern) => {
        if (!relDir) return pattern;
        const neg = pattern.startsWith("!");
        const raw = neg ? pattern.slice(1) : pattern;
        return neg ? `!${relDir}/${raw}` : `${relDir}/${raw}`;
      });
  } catch {
    return [];
  }
}

/**
 * Recursively load .gitignore from root and all subdirectories.
 * Patterns from subdirs are prefixed with their relative path.
 */
export async function loadPatterns(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const all: string[] = [];

  async function walk(dir: string): Promise<void> {
    all.push(...(await loadPatternsFromDir(dir, root)));
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !ALWAYS_IGNORE.some(
          (ig) => e.name + "/" === ig || e.name === ig.replace(/\/$/, "")
        ))
        .map((e) => walk(join(dir, e.name)))
    );
  }

  await walk(root);
  return all;
}

/** Simple glob pattern matching for gitignore-style patterns. */
function matchPattern(filePath: string, pattern: string): boolean {
  // Directory pattern (ends with /)
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return filePath.includes(dir + "/") || filePath.startsWith(dir + "/");
  }

  // Glob pattern with *
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*") +
        "$"
    );
    // Match against filename (basename) for simple globs
    const basename = filePath.split("/").pop() ?? filePath;
    return regex.test(basename) || regex.test(filePath);
  }

  // Exact match or prefix match
  return filePath === pattern || filePath.startsWith(pattern + "/");
}
