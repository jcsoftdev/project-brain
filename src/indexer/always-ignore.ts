import { WATCHER_ALWAYS_IGNORE } from "../constants.js";

/**
 * Whether a repo-relative path falls inside one of the always-ignored
 * directories.
 *
 * Entries in the list name DIRECTORIES, so they must match complete path
 * SEGMENTS. The previous check tested `relPath.startsWith(pattern)` or
 * `relPath.includes("/" + pattern)` without a trailing boundary, which drops
 * real source files whose names merely begin with one of those words: a rule
 * for `target/` removed `console/config/targets.js`, and `build/` removed both
 * `build-roles-index-from-catalog.js` and everything under `builds/`.
 *
 * Those files were absent from a live index with no error anywhere — the same
 * over-matching that `gitignore.ts` documents and guards against, duplicated
 * here without the guard.
 */
export function isAlwaysIgnored(relPath: string): boolean {
  // Bounding both ends turns a substring test into a segment test, so
  // "targets.js" can no longer satisfy "target".
  const bounded = "/" + relPath + "/";
  return WATCHER_ALWAYS_IGNORE.some((pattern) =>
    bounded.includes("/" + pattern.replace(/\/$/, "") + "/")
  );
}
