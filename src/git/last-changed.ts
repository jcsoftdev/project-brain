import { spawnSync } from "node:child_process";

/**
 * When code last changed, according to git.
 *
 * Staleness needs a clock that survives a fresh clone. Filesystem mtimes do
 * not: `git clone` stamps every file with the checkout time, which would mark
 * every concept in the bundle stale the moment someone else pulled it. Commit
 * dates are recorded in the history itself, so they mean the same thing on
 * every machine.
 */

export interface LineRange {
  start: number;
  end: number;
}

export interface CodeChange {
  /** ISO-8601 commit date of the last change, or null when git cannot say. */
  at: string | null;
  /** The working tree holds changes git has not recorded yet. */
  uncommitted: boolean;
}

export interface CodeClock {
  lastChanged(path: string, lines?: LineRange | null): CodeChange;
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function runGit(root: string, args: string[]): GitResult {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  // status is null when the binary is missing entirely — treated the same as a
  // non-zero exit, since both mean "git cannot answer this".
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/**
 * Paths the working tree has modified, staged, or never tracked.
 *
 * `-z` avoids porcelain's path quoting, so a filename with a space or a quote
 * in it stays byte-identical to the key the anchor resolved to. Rename and copy
 * entries carry a second NUL-terminated field for the original path; both sides
 * count as touched.
 */
function readDirtyPaths(root: string): Set<string> {
  const { ok, stdout } = runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const dirty = new Set<string>();
  if (!ok) return dirty;

  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    dirty.add(entry.slice(3));
    if (status[0] === "R" || status[0] === "C") {
      const origin = fields[++i];
      if (origin) dirty.add(origin);
    }
  }
  return dirty;
}

/** First line of `git log --format=%cI` output, which for -L is followed by a diff. */
function firstLine(stdout: string): string | null {
  const line = stdout.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : null;
}

/**
 * A git-backed clock over a repository.
 *
 * The dirty set is read once, on the first query, and reused: a bundle cites
 * the same handful of files over and over, and re-running `git status` per
 * anchor turns an audit into dozens of subprocesses for one unchanging answer.
 */
export function createGitClock(root: string): CodeClock {
  let dirty: Set<string> | null = null;

  return {
    lastChanged(path: string, lines?: LineRange | null): CodeChange {
      dirty ??= readDirtyPaths(root);
      const uncommitted = dirty.has(path);

      if (lines) {
        // -L is precise but brittle: it errors when the range runs past the end
        // of the file, which is itself a sign the concept is out of date. Fall
        // through to the whole file rather than reporting "unknown".
        const ranged = runGit(root, [
          "log",
          "-1",
          "--format=%cI",
          `-L${lines.start},${lines.end}:${path}`,
        ]);
        if (ranged.ok) {
          const at = firstLine(ranged.stdout);
          if (at) return { at, uncommitted };
        }
      }

      const whole = runGit(root, ["log", "-1", "--format=%cI", "--", path]);
      return { at: whole.ok ? firstLine(whole.stdout) : null, uncommitted };
    },
  };
}
