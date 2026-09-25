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

/** Same shape as `node:child_process`'s `spawnSync` — the seam tests inject a spy through. */
export type SpawnFn = typeof spawnSync;

function runGit(root: string, args: string[], spawn: SpawnFn): GitResult {
  const result = spawn("git", args, { cwd: root, encoding: "utf-8" });
  // status is null when the binary is missing entirely — treated the same as a
  // non-zero exit, since both mean "git cannot answer this".
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

interface DirtyPaths {
  /** Every path the working tree touched — definitive when an anchor has no range. */
  all: Set<string>;
  /**
   * Paths with no meaningful diff hunk to overlap a range against: untracked
   * (no HEAD blob) and renamed/copied (the interesting content is the move
   * itself, not a hunk within it). These keep whole-file behaviour.
   */
  wholeFile: Set<string>;
}

/**
 * Paths the working tree has modified, staged, or never tracked.
 *
 * `-z` avoids porcelain's path quoting, so a filename with a space or a quote
 * in it stays byte-identical to the key the anchor resolved to. Rename and copy
 * entries carry a second NUL-terminated field for the original path; both sides
 * count as touched.
 */
function readDirtyPaths(root: string, spawn: SpawnFn): DirtyPaths {
  const { ok, stdout } = runGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"], spawn);
  const all = new Set<string>();
  const wholeFile = new Set<string>();
  if (!ok) return { all, wholeFile };

  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    all.add(path);
    if (status === "??" || status[0] === "R" || status[0] === "C") wholeFile.add(path);
    if (status[0] === "R" || status[0] === "C") {
      const origin = fields[++i];
      if (origin) {
        all.add(origin);
        wholeFile.add(origin);
      }
    }
  }
  return { all, wholeFile };
}

/** New-file-side line ranges a unified diff hunk header (`@@ -a,b +c,d @@`) covers. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Line ranges `path` changed in the working tree, on the new-file side.
 *
 * `-U0 HEAD` diffs the combined staged+unstaged content against the last
 * commit in one call — git compares the working tree straight to HEAD, so a
 * staged-only edit is included without a second query. Returns null when git
 * cannot answer (path not diffable, e.g. untracked), so the caller can fall
 * back to whole-file behaviour instead of reporting no overlap.
 */
function readDirtyHunks(root: string, path: string, spawn: SpawnFn): LineRange[] | null {
  const { ok, stdout } = runGit(root, ["diff", "-U0", "HEAD", "--", path], spawn);
  if (!ok) return null;

  const hunks: LineRange[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(HUNK_HEADER_RE);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    // A pure deletion reports a 0-length new-side range at the line before
    // which it happened — treat it as touching that line so a citation right
    // at the cut still counts as overlapping.
    hunks.push(count === 0 ? { start, end: start } : { start, end: start + count - 1 });
  }
  return hunks;
}

function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** First line of `git log --format=%cI` output, which for -L is followed by a diff. */
function firstLine(stdout: string): string | null {
  const line = stdout.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : null;
}

export interface GitClockDeps {
  /** Injectable in place of `node:child_process`'s `spawnSync`, for tests. */
  spawn?: SpawnFn;
}

/** No two paths or line numbers can produce the same key: NUL cannot appear in either. */
function changeKey(path: string, lines: LineRange | null | undefined): string {
  return lines ? `${path}\0${lines.start},${lines.end}` : `${path}\0`;
}

/**
 * A git-backed clock over a repository.
 *
 * The dirty set is read once, on the first query, and reused: a bundle cites
 * the same handful of files over and over, and re-running `git status` per
 * anchor turns an audit into dozens of subprocesses for one unchanging answer.
 *
 * `lastChanged` results are memoized by path+range for the same reason: an
 * audit's `findStale` calls it once per anchor, and a symbol explained by
 * several concepts — or cited from more than one anchor — would otherwise
 * re-run the same `git log` for an answer already known.
 */
export function createGitClock(root: string, deps: GitClockDeps = {}): CodeClock {
  const spawn = deps.spawn ?? spawnSync;
  let dirty: DirtyPaths | null = null;
  const hunkCache = new Map<string, LineRange[] | null>();
  const changeCache = new Map<string, CodeChange>();

  function isUncommitted(path: string, lines: LineRange | null | undefined): boolean {
    dirty ??= readDirtyPaths(root, spawn);
    if (!dirty.all.has(path)) return false;
    if (!lines || dirty.wholeFile.has(path)) return true;

    let hunks = hunkCache.get(path);
    if (hunks === undefined) {
      hunks = readDirtyHunks(root, path, spawn);
      hunkCache.set(path, hunks);
    }
    // A diff git could not produce falls back to whole-file dirty rather than
    // silently clearing a real uncommitted change.
    if (hunks === null) return true;
    return hunks.some((hunk) => overlaps(hunk, lines));
  }

  return {
    lastChanged(path: string, lines?: LineRange | null): CodeChange {
      const key = changeKey(path, lines);
      const cached = changeCache.get(key);
      if (cached) return cached;

      const uncommitted = isUncommitted(path, lines);
      let result: CodeChange | undefined;

      if (lines) {
        // -L is precise but brittle: it errors when the range runs past the end
        // of the file, which is itself a sign the concept is out of date. Fall
        // through to the whole file rather than reporting "unknown".
        const ranged = runGit(
          root,
          ["log", "-1", "--format=%cI", `-L${lines.start},${lines.end}:${path}`],
          spawn
        );
        if (ranged.ok) {
          const at = firstLine(ranged.stdout);
          if (at) result = { at, uncommitted };
        }
      }

      if (!result) {
        const whole = runGit(root, ["log", "-1", "--format=%cI", "--", path], spawn);
        result = { at: whole.ok ? firstLine(whole.stdout) : null, uncommitted };
      }

      changeCache.set(key, result);
      return result;
    },
  };
}
