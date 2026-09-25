import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ManifestStore } from "../indexer/manifest-store.js";
import type { BenchQuery } from "./run.js";

/** Same shape as `node:child_process`'s `spawnSync` — the seam tests inject a fake through. */
export type SpawnFn = typeof spawnSync;

/** How many commits survived each filter stage, in pipeline order — for reporting the funnel. */
export interface MineStats {
  scanned: number;
  afterNoiseSubject: number;
  afterFileCountBound: number;
  afterNoisePath: number;
  afterIndexFilter: number;
  afterSurvivalFilter: number;
}

export interface MineOptions {
  /** Cap on how many most-recent non-merge commits `git log` scans. Default: entire history. */
  limit?: number;
  /** Commits touching more files than this are mass edits (refactors, renames), not focused ground truth. */
  maxFiles?: number;
  /**
   * Minimum fraction of a commit's added lines to a file that must still be
   * attributed to that commit by `git blame` at HEAD for the file to remain
   * a gold target. Guards against temporal drift: a commit whose changes
   * were later rewritten or deleted no longer describes the code at HEAD,
   * even though it once did. Default 0.5.
   */
  minSurvival?: number;
  /** Repo to mine — defaults to the current working directory. */
  cwd?: string;
  /** DI seam for tests: replaces every `git` invocation (log x2, blame per file). */
  spawn?: SpawnFn;
  /**
   * Whether `path` is present in the project's index. Defaults to a check
   * against `.project-brain/manifest.db` at `cwd` (a file with chunks — a
   * manifest entry with zero chunks was walked but never actually indexed).
   */
  isIndexed?: (path: string) => boolean;
  /** Called once with the per-stage funnel counts after mining finishes. */
  onStats?: (stats: MineStats) => void;
}

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MIN_SURVIVAL = 0.5;

/** Field separator between hash/subject/body in the metadata `git log` call. Never appears in real commit text. */
const FIELD_SEP = "\x01";

/**
 * A commit subject that is release bookkeeping rather than a change someone
 * would ask a search engine about — nobody searches "chore(release): 0.32.1".
 */
const NOISE_SUBJECT = /^chore\(release\)|^release[:\s]|^bump(\s+version)?\b|^v?\d+\.\d+\.\d+$/i;

export function isNoiseSubject(subject: string): boolean {
  return NOISE_SUBJECT.test(subject.trim());
}

/**
 * Files that exist but that project-brain does not meaningfully index —
 * lockfiles, manifests and changelogs are machine-generated or pure
 * bookkeeping, so a commit touching only these has no useful "expect" target.
 */
const NOISE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "go.sum",
  "package.json",
  "CHANGELOG.md",
  "CHANGELOG",
  "LICENSE",
  "LICENSE.md",
  ".gitignore",
  ".npmignore",
]);

export function isNoisePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return NOISE_BASENAMES.has(base);
}

/**
 * First paragraph of a commit body, collapsed to one line — the paragraph a
 * human would read as the "why", not the bullet-list detail below it.
 */
function firstParagraph(body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/).filter((p) => p.trim() !== "");
  if (paragraphs.length === 0) return "";
  return paragraphs[0]!.split("\n").map((l) => l.trim()).join(" ");
}

/**
 * Query = subject, plus the first body paragraph when it is short enough to
 * still read like a query rather than a paste of the whole commit message. A
 * long paragraph dilutes the embedding instead of sharpening it.
 */
const MAX_PARAGRAPH_CHARS = 240;

function buildQuery(subject: string, body: string): string {
  const para = firstParagraph(body);
  if (para && para.length <= MAX_PARAGRAPH_CHARS) return `${subject} ${para}`;
  return subject;
}

interface CommitMeta {
  hash: string;
  subject: string;
  body: string;
}

/**
 * Parse `git log -z --pretty=format:%H<SEP>%s<SEP>%b`.
 *
 * With `-z`, git NUL-terminates each record and adds NO trailing NUL after
 * the very last one — so a plain split on "\0" yields exactly one chunk per
 * commit, each "hash<SEP>subject<SEP>body".
 */
function parseMeta(stdout: string): CommitMeta[] {
  return stdout
    .split("\0")
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [hash, subject, ...rest] = chunk.split(FIELD_SEP);
      return { hash: hash!, subject: subject ?? "", body: rest.join(FIELD_SEP) };
    });
}

interface NumstatEntry {
  path: string;
  /** Lines this commit added to `path`. Binary files report "-" and become 0. */
  added: number;
}

/**
 * Parse `git log -z --numstat --pretty=format:%H`.
 *
 * Same per-commit NUL framing as a plain `--name-only` call (`-z` NUL-
 * terminates every token, not just the record, so a commit's output is
 * "hash\ntoken1\0token2\0...\0tokenN\0" immediately followed by a second NUL
 * marking the record boundary — except after the very last commit, which
 * carries only its last token's trailing NUL). `--numstat` additionally
 * prefixes each token with "<added>\t<deleted>\t" before the path.
 */
function parseNumstat(stdout: string): Map<string, NumstatEntry[]> {
  const map = new Map<string, NumstatEntry[]>();
  const NUMSTAT_TOKEN = /^(\d+|-)\t(?:\d+|-)\t([\s\S]*)$/;

  const push = (entries: NumstatEntry[], token: string): void => {
    const m = NUMSTAT_TOKEN.exec(token);
    if (!m) return;
    entries.push({ path: m[2]!, added: m[1] === "-" ? 0 : Number(m[1]) });
  };

  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    if (parts[i] === "") {
      i++;
      continue;
    }
    const nl = parts[i]!.indexOf("\n");
    const hash = nl === -1 ? parts[i]! : parts[i]!.slice(0, nl);
    const firstToken = nl === -1 ? "" : parts[i]!.slice(nl + 1);
    const entries: NumstatEntry[] = [];
    if (firstToken) push(entries, firstToken);
    i++;
    while (i < parts.length && parts[i] !== "") {
      push(entries, parts[i]!);
      i++;
    }
    map.set(hash, entries);
  }
  return map;
}

/** A `git blame --line-porcelain` header line: "<sha> <origline> <finalline> [<numlines>]". */
const BLAME_HEADER = /^([0-9a-f]+) \d+ \d+/;

/**
 * How many lines of `file`, as it stands at HEAD, `git blame` attributes to
 * each commit that ever touched it — the survival signal.
 *
 * A file deleted, or renamed away from this exact path, has nothing to
 * survive: blame fails against a nonexistent path, so this returns an empty
 * map rather than throwing, and every commit naming that file scores zero
 * survival instead of aborting the whole mining run.
 */
function blameLineCounts(cwd: string, file: string, spawn: SpawnFn): Map<string, number> {
  const result = spawn("git", ["blame", "--line-porcelain", "HEAD", "--", file], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 256,
  });
  const counts = new Map<string, number>();
  if (result.status !== 0) return counts;
  for (const line of (result.stdout ?? "").split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

/**
 * Default `isIndexed`: files the indexer actually chunked, per the manifest
 * it already keeps at `<cwd>/.project-brain/manifest.db` — reading that
 * instead of re-walking the tree is the same store `sync`/`reindex` write to.
 * A manifest entry with zero chunks was walked but produced nothing
 * retrievable (e.g. an unsupported extension), so it does not count as indexed.
 *
 * Falls back to "everything is indexed" (no-op filter) when the project has
 * never been indexed here, rather than failing mining outright.
 */
function defaultIsIndexed(cwd: string): (path: string) => boolean {
  const dbPath = join(cwd, ".project-brain", "manifest.db");
  if (!existsSync(dbPath)) {
    console.warn(
      "bench mine: no project index found at .project-brain/manifest.db — skipping the not-indexed filter"
    );
    return () => true;
  }
  const store = new ManifestStore(cwd);
  const indexed = new Set<string>();
  for (const path of store.listPaths()) {
    const entry = store.getEntry(path);
    if (entry && Object.keys(entry.chunks).length > 0) indexed.add(path);
  }
  store.close();
  return (path: string) => indexed.has(path);
}

function runGit(cwd: string, args: string[], spawn: SpawnFn): string {
  const result = spawn("git", args, { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || "unknown error"}`);
  }
  return result.stdout ?? "";
}

/**
 * Mine bench ground truth from commit history: query = subject (+ short first
 * body paragraph), expect = the files that commit changed.
 *
 * A commit survives, in order:
 * 1. `--no-merges` and a release/version-bump subject filter.
 * 2. A file-count bound (`maxFiles`) — mass edits are noise, not a focused
 *    query -> file mapping.
 * 3. Per-file: not a lockfile/manifest/changelog (`isNoisePath`).
 * 4. Per-file: present in the project's index (`isIndexed`).
 * 5. Per-file: a `minSurvival` share of the lines this commit added to it
 *    are still attributed to it by `git blame` at HEAD — otherwise the
 *    commit's message describes code that has since been rewritten or
 *    deleted, and no longer matches what a search at HEAD would find.
 *
 * A commit with zero gold files left after any of these is dropped entirely.
 *
 * Deterministic: every `git log` call walks the same fixed commit history in
 * the same order, and `git blame` reads the same fixed HEAD, so re-running
 * against an unchanged repo reproduces the same file byte-for-byte.
 */
export function mineQueries(opts: MineOptions = {}): BenchQuery[] {
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawn ?? spawnSync;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const minSurvival = opts.minSurvival ?? DEFAULT_MIN_SURVIVAL;
  const isIndexed = opts.isIndexed ?? defaultIsIndexed(cwd);
  const limitArgs = opts.limit ? [`-${opts.limit}`] : [];

  const metaOut = runGit(
    cwd,
    ["log", "-z", "--no-merges", ...limitArgs, `--pretty=format:%H${FIELD_SEP}%s${FIELD_SEP}%b`],
    spawn
  );
  const numstatOut = runGit(
    cwd,
    ["log", "-z", "--no-merges", ...limitArgs, "--numstat", "--pretty=format:%H"],
    spawn
  );

  const numstatByHash = parseNumstat(numstatOut);
  const commits = parseMeta(metaOut);

  const stats: MineStats = {
    scanned: commits.length,
    afterNoiseSubject: 0,
    afterFileCountBound: 0,
    afterNoisePath: 0,
    afterIndexFilter: 0,
    afterSurvivalFilter: 0,
  };

  // Blame reads the file's history once, so many commits sharing a file (the
  // common case) pay for it once — not once per commit that touched it.
  const blameCache = new Map<string, Map<string, number>>();
  function survivingLines(file: string, sha: string): number {
    let counts = blameCache.get(file);
    if (!counts) {
      counts = blameLineCounts(cwd, file, spawn);
      blameCache.set(file, counts);
    }
    return counts.get(sha) ?? 0;
  }

  const out: BenchQuery[] = [];

  for (const commit of commits) {
    if (isNoiseSubject(commit.subject)) continue;
    stats.afterNoiseSubject++;

    const changed = numstatByHash.get(commit.hash) ?? [];
    if (changed.length === 0 || changed.length > maxFiles) continue;
    stats.afterFileCountBound++;

    const notNoise = changed.filter((c) => !isNoisePath(c.path));
    if (notNoise.length === 0) continue;
    stats.afterNoisePath++;

    const indexed = notNoise.filter((c) => isIndexed(c.path));
    if (indexed.length === 0) continue;
    stats.afterIndexFilter++;

    const survived = indexed.filter(
      (c) => c.added > 0 && survivingLines(c.path, commit.hash) / c.added >= minSurvival
    );
    if (survived.length === 0) continue;
    stats.afterSurvivalFilter++;

    out.push({
      query: buildQuery(commit.subject, commit.body),
      expect: survived.map((c) => c.path),
    });
  }

  opts.onStats?.(stats);
  return out;
}

/** One JSON object per line — a single-file `expect` serializes as a plain string for readability/diffability. */
export function formatQueriesJsonl(queries: BenchQuery[]): string {
  return queries
    .map((q) => {
      const expect = Array.isArray(q.expect) && q.expect.length === 1 ? q.expect[0] : q.expect;
      return JSON.stringify({ query: q.query, expect });
    })
    .join("\n") + "\n";
}
