import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isNoisePath, type SpawnFn } from "../bench/mine.js";
import { looksLikeTest } from "./audit.js";
import { ask, type TypesafeFetchFn } from "../typesafe/client.js";
import { collectAnchors } from "./anchors.js";
import type { AuditGraph, SymbolTable } from "./audit.js";
import type { RankedSymbol } from "../graph/store.js";
import { readSymbols } from "./audit.js";
import type { Bundle } from "./bundle.js";
import type { BundleLayout } from "./anchors.js";

/**
 * `project-brain okf candidates` — mines `fix:` commits from git history and
 * ranks them as candidate Open Knowledge Format concepts.
 *
 * Reuses `src/bench/mine.ts`'s git-log parsing patterns (NUL-framed records,
 * `--numstat` for per-file changed lines, a noise-path filter) rather than a
 * bespoke history walk, and `src/okf/audit.ts`'s `SymbolTable` for anchor
 * resolution rather than a second symbol lookup path.
 */

// --- mining ---------------------------------------------------------------

export interface FileChange {
  path: string;
  /** added + deleted, from `git show --numstat`. */
  lines: number;
}

export interface FixCommit {
  hash: string;
  subject: string;
  body: string;
  changes: FileChange[];
}

/** Matches a conventional `fix:` or `fix(scope):` subject — the commits this command mines. */
const FIX_SUBJECT = /^fix(\([^)]*\))?:\s?/i;

const FIELD_SEP = "\x01";

interface CommitMeta {
  hash: string;
  subject: string;
  body: string;
}

/** Parses `git log -z --pretty=format:%H<SEP>%s<SEP>%b` — same NUL framing as bench/mine.ts's parseMeta. */
function parseMeta(stdout: string): CommitMeta[] {
  return stdout
    .split("\0")
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [hash, subject, ...rest] = chunk.split(FIELD_SEP);
      return { hash: hash!, subject: subject ?? "", body: rest.join(FIELD_SEP).trim() };
    });
}

const NUMSTAT_TOKEN = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/** Parses `git log -z --numstat --pretty=format:%H` into per-commit file changes. Same framing as bench/mine.ts's parseNumstat. */
function parseNumstat(stdout: string): Map<string, FileChange[]> {
  const map = new Map<string, FileChange[]>();
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
    const changes: FileChange[] = [];
    const push = (token: string): void => {
      const m = NUMSTAT_TOKEN.exec(token);
      if (!m) return;
      const added = m[1] === "-" ? 0 : Number(m[1]);
      const deleted = m[2] === "-" ? 0 : Number(m[2]);
      changes.push({ path: m[3]!, lines: added + deleted });
    };
    if (firstToken) push(firstToken);
    i++;
    while (i < parts.length && parts[i] !== "") {
      push(parts[i]!);
      i++;
    }
    map.set(hash, changes);
  }
  return map;
}

/**
 * `--since <rev|date>` heuristic: a value `Date.parse` understands is a date
 * (`--since=<date>`); anything else — a short SHA, a tag, a branch name — is
 * treated as a rev and turned into a `<rev>..HEAD` range. Avoids a second git
 * call (e.g. `rev-parse --verify`) just to disambiguate.
 */
function sinceArgs(since: string | undefined): string[] {
  if (!since) return [];
  return Number.isNaN(Date.parse(since)) ? [`${since}..HEAD`] : [`--since=${since}`];
}

function runGit(cwd: string, args: string[], spawn: SpawnFn): string {
  const result = spawn("git", args, { cwd, encoding: "utf-8", maxBuffer: 1024 * 1024 * 256 });
  return result.status === 0 ? result.stdout ?? "" : "";
}

export interface MineFixCommitsOptions {
  cwd: string;
  spawn?: SpawnFn;
  /** Only commits after this rev or date. */
  since?: string;
  /** Cap on how many most-recent non-merge commits to scan. */
  limit?: number;
}

/** Mines every `fix:`/`fix(scope):` commit in range, with its body and per-file changed-line counts. */
export function mineFixCommits(opts: MineFixCommitsOptions): FixCommit[] {
  const spawn = opts.spawn ?? spawnSync;
  const rangeArgs = sinceArgs(opts.since);
  const limitArgs = opts.limit ? [`-${opts.limit}`] : [];
  const common = ["log", "-z", "--no-merges", ...rangeArgs, ...limitArgs];

  const metaOut = runGit(opts.cwd, [...common, `--pretty=format:%H${FIELD_SEP}%s${FIELD_SEP}%b`], spawn);
  const numstatOut = runGit(opts.cwd, [...common, "--numstat", "--pretty=format:%H"], spawn);
  const changesByHash = parseNumstat(numstatOut);

  return parseMeta(metaOut)
    .filter((c) => FIX_SUBJECT.test(c.subject))
    .map((c) => ({ hash: c.hash, subject: c.subject, body: c.body, changes: changesByHash.get(c.hash) ?? [] }));
}

// --- anchor proposal --------------------------------------------------------

export interface AnchorProposal {
  /** What would go in a concept's `resource:` field (relative to the bundle root is the caller's job). */
  proposed: string;
  path: string;
  symbol: string | null;
  resolved: boolean;
}

/**
 * Proposes an anchor for a candidate commit: the file it changed the most
 * (excluding lockfiles/manifests, via `isNoisePath`, and preferring source
 * over tests — a fix usually adds a larger regression test than the change it
 * guards, and a concept anchored on the test explains the wrong thing), at that file's
 * highest-ranked symbol — `SymbolTable.byFile` is already sorted by
 * descending PageRank, so `[0]` is exactly that without a second sort. Falls
 * back to a whole-file anchor when the file has no parsed symbols, and never
 * fabricates a symbol: since it is read live from `symbols`, a resolvable
 * symbol answer is a live one by construction. Only the file's continued
 * existence on disk is checked explicitly, since the graph can lag a deletion.
 */
/**
 * The function context git prints after each hunk range of a diff
 * (`@@ -a,b +c,d @@ <context>`), one entry per hunk, "" when git printed none.
 * That context is the enclosing definition as of the commit itself, so it
 * does not drift the way line numbers checked against today's graph would.
 */
export function parseHunkHeaders(diff: string): string[] {
  const headers: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ [^@]* @@ ?(.*)$/.exec(line);
    if (match) headers.push(match[1]!.trim());
  }
  return headers;
}

/** Hunk headers for one file of one commit — injectable so tests never shell out. */
export type HunkHeadersFn = (hash: string, path: string) => string[];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The symbol most hunks sit in: the one named, as a whole identifier, by the
 * most hunk headers. Ties and "no header names anything" keep PageRank order,
 * since `inFile` is already sorted by it.
 */
function pickChangedSymbol(inFile: RankedSymbol[], headers: string[]): string {
  let best = inFile[0]!.name;
  let bestHits = 0;
  for (const s of inFile) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(s.name)}([^A-Za-z0-9_$]|$)`);
    const hits = headers.filter((h) => pattern.test(h)).length;
    if (hits > bestHits) {
      best = s.name;
      bestHits = hits;
    }
  }
  return best;
}

export function proposeAnchor(
  commit: FixCommit,
  symbols: SymbolTable,
  exists: (path: string) => boolean,
  hunkHeaders?: HunkHeadersFn
): AnchorProposal {
  const candidates = commit.changes.filter((c) => !isNoisePath(c.path));
  const source = candidates.filter((c) => !looksLikeTest(c.path));
  const pool = source.length > 0 ? source : candidates.length > 0 ? candidates : commit.changes;
  if (pool.length === 0) return { proposed: "", path: "", symbol: null, resolved: false };

  const top = pool.reduce((best, c) => (c.lines > best.lines ? c : best));
  const inFile = symbols.byFile.get(top.path);
  const symbol =
    inFile && inFile.length > 0
      ? hunkHeaders
        ? pickChangedSymbol(inFile, hunkHeaders(commit.hash, top.path))
        : inFile[0]!.name
      : null;

  return {
    proposed: symbol ? `${top.path}#${symbol}` : top.path,
    path: top.path,
    symbol,
    resolved: exists(top.path),
  };
}

// --- already-covered skip ---------------------------------------------------

/** NUL separator between path and symbol — no path or symbol can contain it. */
function coverageKey(path: string, symbol: string): string {
  return `${path}\0${symbol}`;
}

/**
 * Every anchor an existing bundle already declares, as a lookup set for
 * `isCovered`. A whole-file anchor (no `#symbol`) is stored under its bare
 * path and covers every symbol in that file — matching `buildCoverage` in
 * `audit.ts`. Deliberately reuses `collectAnchors` rather than the full
 * anchor-resolution pipeline: a candidate mention only needs to know a
 * concept ALREADY CLAIMS this code, not whether that claim currently resolves.
 */
export function buildCoveredAnchors(bundle: Bundle, layout: BundleLayout): Set<string> {
  const covered = new Set<string>();
  for (const anchor of collectAnchors(bundle, layout)) {
    covered.add(anchor.symbol ? coverageKey(anchor.path, anchor.symbol) : anchor.path);
  }
  return covered;
}

export function isCovered(covered: Set<string>, path: string, symbol: string | null): boolean {
  if (covered.has(path)) return true;
  return symbol !== null && covered.has(coverageKey(path, symbol));
}

// --- Jev scoring ------------------------------------------------------------

export interface CommitScore {
  /** "the cause of the bug was surprising: the symptom pointed somewhere else." */
  surprising: number | null;
  /** "the fix encodes a constraint that, if violated, breaks something in a different module." */
  constraint: number | null;
  /** "the commit rejects a plausible alternative for a non-obvious reason." */
  rejectedAlternative: number | null;
  /** Overall OKF-worthiness, normalized to 0..1 from the `score` question's level index. */
  worthiness: number | null;
}

const NULL_SCORE: CommitScore = { surprising: null, constraint: null, rejectedAlternative: null, worthiness: null };

/** Ordered worthiness levels for the `score` question — index 0 is "not worth it". */
const WORTHINESS_CRITERIA = [
  "not worth documenting",
  "maybe worth a note",
  "worth documenting",
  "clearly worth documenting",
];

const MAX_BODY_CHARS = 2000;
const MAX_FILES = 20;

export interface ScoreCommitOptions {
  fetchFn?: TypesafeFetchFn;
  timeoutMs?: number;
}

/**
 * Asks Jev the four OKF-worthiness questions for one commit, in a SINGLE
 * call (System One evaluates them in parallel against the same state). Never
 * throws: any `ask()` failure resolves every field to null rather than
 * failing the whole `candidates` run over one commit.
 */
export async function scoreCommit(
  commit: Pick<FixCommit, "subject" | "body"> & { files: string[] },
  token: string,
  options: ScoreCommitOptions = {}
): Promise<CommitScore> {
  const answers = await ask(
    token,
    {
      subject: commit.subject,
      body: commit.body.slice(0, MAX_BODY_CHARS),
      files: commit.files.slice(0, MAX_FILES),
    },
    {
      surprising: {
        type: "noul",
        instructions: "The cause of the bug this commit fixes was surprising: the symptom pointed somewhere else than the eventual fix.",
      },
      constraint: {
        type: "noul",
        instructions: "The fix in this commit encodes a constraint that, if violated, would break something in a different module.",
      },
      rejectedAlternative: {
        type: "noul",
        instructions: "The commit message or diff suggests a plausible alternative fix was considered and rejected for a non-obvious reason.",
      },
      worthiness: {
        type: "score",
        instructions: "How worthy is this commit of a permanent Open Knowledge Format concept documenting the reasoning behind the fix?",
        criteria: WORTHINESS_CRITERIA,
      },
    },
    { fetchFn: options.fetchFn, timeoutMs: options.timeoutMs }
  );

  if (!answers) return NULL_SCORE;
  return {
    surprising: answers.surprising.noul,
    constraint: answers.constraint.noul,
    rejectedAlternative: answers.rejectedAlternative.noul,
    worthiness: answers.worthiness.score / (WORTHINESS_CRITERIA.length - 1),
  };
}

/**
 * Combines the four questions into one rank — weights sum to 1, chosen so
 * overall worthiness (a direct judgment of "is this worth an OKF concept")
 * outweighs any single contributing signal, while the three specific signals
 * still move the needle: a commit that is merely long-winded should not
 * outrank one Jev found genuinely surprising.
 */
const RANK_WEIGHTS = { surprising: 0.25, constraint: 0.25, rejectedAlternative: 0.2, worthiness: 0.3 } as const;

function rankScore(score: CommitScore): number {
  return (
    RANK_WEIGHTS.surprising * (score.surprising ?? 0) +
    RANK_WEIGHTS.constraint * (score.constraint ?? 0) +
    RANK_WEIGHTS.rejectedAlternative * (score.rejectedAlternative ?? 0) +
    RANK_WEIGHTS.worthiness * (score.worthiness ?? 0)
  );
}

/** Distinct top-two-segment "modules" touched — a cheap proxy for how cross-cutting a commit is. */
function distinctModules(paths: string[]): number {
  return new Set(paths.map((p) => p.split("/").slice(0, 2).join("/"))).size;
}

/**
 * Heuristic rank used when no TypeSafe token is configured: commits touching
 * more distinct modules, with a longer explanation, are more likely to encode
 * a real cross-cutting decision worth writing down. Documented rather than
 * tuned — it is a fallback, not the primary ranking.
 */
function heuristicRank(commit: FixCommit): number {
  return distinctModules(commit.changes.map((c) => c.path)) * 500 + commit.body.length;
}

// --- orchestration -----------------------------------------------------------

export interface CandidateEntry {
  hash: string;
  subject: string;
  rank: number;
  /** null in heuristic mode (no token configured). */
  scores: CommitScore | null;
  anchor: AnchorProposal;
}

export interface MineCandidatesResult {
  candidates: CandidateEntry[];
  /** True when ranked without Jev (no token) — see `notice`. */
  heuristic: boolean;
  notice?: string;
  /** How many fix: commits were mined before the already-covered skip and topN cut. */
  scanned: number;
}

const DEFAULT_TOP_N = 20;
const DEFAULT_CONCURRENCY = 3;

export interface MineCandidatesOptions {
  cwd: string;
  spawn?: SpawnFn;
  since?: string;
  /** Commits to scan from git history. Default: entire history. */
  scanLimit?: number;
  /** Ranked candidates to return. Default 20. */
  topN?: number;
  graph: AuditGraph;
  /** Null/absent → heuristic ranking, with `notice` explaining why. */
  token?: string | null;
  fetchFn?: TypesafeFetchFn;
  timeoutMs?: number;
  concurrency?: number;
  /** Existing bundle, to skip commits an existing concept already covers. Absent → nothing is skipped. */
  bundle?: Bundle;
  bundleLayout?: BundleLayout;
  /** Whether a repo-relative path still exists on disk. Defaults to a real fs check under `cwd`. */
  fsExists?: (path: string) => boolean;
  /** Hunk headers per commit+file. Default: `git show -U0` in `cwd`. */
  hunkHeaders?: HunkHeadersFn;
}

/**
 * Mines, anchors, scores, and ranks OKF concept candidates from `fix:`
 * commit history. See the module doc for the pipeline this composes.
 */
export async function mineOkfCandidates(opts: MineCandidatesOptions): Promise<MineCandidatesResult> {
  const commits = mineFixCommits({ cwd: opts.cwd, spawn: opts.spawn, since: opts.since, limit: opts.scanLimit });
  const symbols = readSymbols(opts.graph);
  const exists = opts.fsExists ?? ((p: string) => existsSync(join(opts.cwd, p)));
  const covered = opts.bundle && opts.bundleLayout ? buildCoveredAnchors(opts.bundle, opts.bundleLayout) : new Set<string>();
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const spawn = opts.spawn ?? spawnSync;
  const hunkHeaders: HunkHeadersFn =
    opts.hunkHeaders ??
    ((hash, path) => parseHunkHeaders(runGit(opts.cwd, ["show", "-U0", "--format=", hash, "--", path], spawn)));

  const withAnchor = commits
    .map((commit) => ({ commit, anchor: proposeAnchor(commit, symbols, exists, hunkHeaders) }))
    .filter(({ anchor }) => !isCovered(covered, anchor.path, anchor.symbol));

  if (!opts.token) {
    const candidates = withAnchor
      .map(({ commit, anchor }): CandidateEntry => ({
        hash: commit.hash,
        subject: commit.subject,
        rank: heuristicRank(commit),
        scores: null,
        anchor,
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, topN);
    return {
      candidates,
      heuristic: true,
      notice:
        "no TypeSafe token configured — ranked by a heuristic (distinct modules touched, body length). " +
        "Set TYPESAFE_API_KEY for Jev-scored ranking.",
      scanned: commits.length,
    };
  }

  const token = opts.token;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results: CandidateEntry[] = new Array(withAnchor.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < withAnchor.length) {
      const i = cursor++;
      const { commit, anchor } = withAnchor[i]!;
      const scores = await scoreCommit(
        { subject: commit.subject, body: commit.body, files: commit.changes.map((c) => c.path) },
        token,
        { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs }
      );
      results[i] = { hash: commit.hash, subject: commit.subject, rank: rankScore(scores), scores, anchor };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, withAnchor.length) }, () => worker()));

  return {
    candidates: results.sort((a, b) => b.rank - a.rank).slice(0, topN),
    heuristic: false,
    scanned: commits.length,
  };
}

// --- formatting --------------------------------------------------------------

function scoreCell(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

/** Prose table: rank, short hash, subject, the four scores, and the anchor with its resolved flag. */
export function formatCandidates(result: MineCandidatesResult): string {
  const lines = [`project-brain okf candidates — ${result.scanned} fix: commit${result.scanned === 1 ? "" : "s"} scanned`];
  if (result.heuristic && result.notice) lines.push(`  ${result.notice}`);

  if (result.candidates.length === 0) {
    lines.push("", "  nothing ranked — every fix: commit is already covered, or none were found");
    return lines.join("\n");
  }

  lines.push("");
  result.candidates.forEach((c, i) => {
    const anchorMark = c.anchor.resolved ? c.anchor.proposed : `${c.anchor.proposed} (UNRESOLVED)`;
    const scoreText = c.scores
      ? `surprising=${scoreCell(c.scores.surprising)} constraint=${scoreCell(c.scores.constraint)} ` +
        `alt=${scoreCell(c.scores.rejectedAlternative)} worthiness=${scoreCell(c.scores.worthiness)}`
      : "(heuristic)";
    lines.push(`  ${i + 1}. ${c.hash.slice(0, 7)} ${c.subject}`);
    lines.push(`     rank=${c.rank.toFixed(2)} ${scoreText}`);
    lines.push(`     anchor: ${anchorMark}`);
  });
  return lines.join("\n");
}
