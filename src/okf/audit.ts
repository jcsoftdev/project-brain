import type { CodeClock, LineRange } from "../git/last-changed.js";
import type { RankedSymbol, SymbolHit } from "../graph/store.js";
import { collectAnchors, type Anchor, type BundleLayout } from "./anchors.js";
import type { Bundle } from "./bundle.js";

/**
 * The cross-graph audit.
 *
 * project-brain holds two graphs over the same repository. The call graph is
 * derived, typed, and always current — it says what the code does. The bundle
 * is curated, untyped, and only as current as its author left it — it says why.
 * Anchors join them, and every finding here comes from that join: a claim
 * pointing at code that moved, an explanation older than what it explains,
 * important code nobody explained, and explanations whose code talks but whose
 * prose does not. None of these are answerable inside either graph alone.
 */

export interface AuditGraph {
  pageRank(opts?: { damping?: number; iterations?: number; focus?: string[] }): RankedSymbol[];
  findCallers(name: string): SymbolHit[];
  impact(name: string, maxDepth?: number): SymbolHit[];
}

export interface AuditDeps {
  graph: AuditGraph;
  clock: CodeClock;
  /** Whether a repo-relative path is still on disk. */
  exists(repoRelPath: string): boolean;
  /** How many uncovered symbols to report. Default 10. */
  coverageLimit?: number;
  /** Injectable clock for `stale_after` comparisons. Defaults to `new Date()`. */
  now?: Date;
  /**
   * A symbol table already built by `readSymbols(graph)`. When the caller runs
   * more than one pass over the same graph in one command (audit + `--symbol`
   * impact), passing it in here skips a second `graph.pageRank()` — the most
   * expensive call this module makes.
   */
  symbols?: SymbolTable;
}

export type AnchorResolution = "ok" | "missing-file" | "missing-symbol";

export interface ResolvedAnchor extends Anchor {
  resolution: AnchorResolution;
  /** Line span this anchor points at, once a symbol anchor has been looked up. */
  range: LineRange | null;
  /** Closest symbol name in the same file, when `resolution` is "missing-symbol". */
  hint?: string;
}

/** A symbol anchor whose name matched more than one symbol in the file. */
export interface AmbiguousAnchor {
  concept: string;
  resource: string;
  path: string;
  symbol: string;
}

export interface StaleFinding {
  concept: string;
  resource: string;
  path: string;
  attestedAt: string | null;
  changedAt: string | null;
  reason: "code-changed" | "uncommitted" | "expired";
  /** The `stale_after` threshold that passed. Present only when reason is "expired". */
  expiresAt?: string;
  /** Line span the anchor cited, when it named one — feeds `okf audit --judge`'s diff evidence. */
  range: LineRange | null;
  /** Set by `okf audit --judge`. Absent until then. */
  judge?: { verdict: "holds" | "outdated" | "unclear"; reason: string };
}

export interface CoverageGap {
  name: string;
  kind: string;
  file: string;
  rank: number;
}

export interface LinkSuggestion {
  /** Concept explaining the calling side. */
  from: string;
  /** Concept explaining the called side. */
  to: string;
  because: { caller: string; callee: string };
}

export interface AuditReport {
  anchors: ResolvedAnchor[];
  broken: ResolvedAnchor[];
  stale: StaleFinding[];
  /**
   * Stale findings a human confirmed still hold via `okf audit --judge` (only
   * ever populated by that command layer — `auditBundle` itself always
   * returns this empty, since judging needs a live LLM call). Backlog, not a
   * failure: the audit's promise that a failing run needs a human look stays
   * intact, so a model's "still holds" downgrades a finding rather than
   * clearing it outright.
   */
  judged: StaleFinding[];
  /** Concepts that anchor code but carry no attestation to measure staleness against. */
  unattested: string[];
  /** Symbol anchors whose name matched more than one symbol — a warning, not a failure. */
  ambiguous: AmbiguousAnchor[];
  coverage: CoverageGap[];
  links: LinkSuggestion[];
}

export interface ImpactedConcept {
  concept: string;
  via: { name: string; file: string };
}

const DEFAULT_COVERAGE_LIMIT = 10;

/** NUL separator — no path or identifier can contain it, so keys never collide. */
function symbolKey(file: string, name: string): string {
  return `${file}\0${name}`;
}

export interface SymbolTable {
  /** All symbols, already sorted by descending PageRank. */
  ranked: RankedSymbol[];
  byFile: Map<string, RankedSymbol[]>;
}

/**
 * Reads the whole symbol table once.
 *
 * `pageRank` is the only whole-graph enumeration the store exposes, and its
 * ranks are what makes the coverage backlog a priority order rather than a
 * dump — so one call feeds anchor resolution, coverage, and link inference.
 *
 * Exported so a caller running more than one pass over the same graph (the
 * CLI's audit + `--symbol` impact pass) can build it once and hand it to both
 * via `AuditDeps.symbols` / the `impactedConcepts` deps, instead of paying for
 * a second `graph.pageRank()`.
 */
export function readSymbols(graph: AuditGraph): SymbolTable {
  const ranked = graph.pageRank();
  const byFile = new Map<string, RankedSymbol[]>();
  for (const symbol of ranked) {
    const bucket = byFile.get(symbol.file);
    if (bucket) bucket.push(symbol);
    else byFile.set(symbol.file, [symbol]);
  }
  return { ranked, byFile };
}

/**
 * Picks the symbol a `#name` anchor refers to. The anchor grammar carries no
 * range beside a name, so same-named symbols in one file cannot be told apart:
 * take the first and tell the caller, which surfaces it as a warning rather
 * than silently guessing.
 */
function findNamedSymbol(
  inFile: RankedSymbol[],
  name: string
): { hit: RankedSymbol | undefined; ambiguous: boolean } {
  const matches = inFile.filter((s) => s.name === name);
  return { hit: matches[0], ambiguous: matches.length > 1 };
}

/** Classic edit distance — no dependency needed for symbol-name-length strings. */
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[b.length];
}

/** Closest name among candidates, only when close enough to plausibly be a rename. */
function closestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshtein(name, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  const threshold = Math.max(2, name.length * 0.3);
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

function resolveAnchor(
  anchor: Anchor,
  byFile: Map<string, RankedSymbol[]>,
  exists: (path: string) => boolean
): { resolved: ResolvedAnchor; ambiguous: boolean } {
  if (!exists(anchor.path)) {
    return { resolved: { ...anchor, resolution: "missing-file", range: null }, ambiguous: false };
  }

  const inFile = byFile.get(anchor.path);
  if (anchor.symbol !== null && inFile !== undefined) {
    // Only judge a symbol missing when the graph actually holds symbols for
    // that file. The parser covers a fixed set of languages, so silence means
    // "not parsed", not "not there" — and calling a live anchor broken is worse
    // than missing a dead one.
    const { hit, ambiguous } = findNamedSymbol(inFile, anchor.symbol);
    if (!hit) {
      const hint = closestName(anchor.symbol, new Set(inFile.map((s) => s.name)));
      return { resolved: { ...anchor, resolution: "missing-symbol", range: null, hint }, ambiguous: false };
    }
    return {
      resolved: {
        ...anchor,
        resolution: "ok",
        range: anchor.lines ?? { start: hit.start_line, end: hit.end_line },
      },
      ambiguous,
    };
  }

  return { resolved: { ...anchor, resolution: "ok", range: anchor.lines ?? null }, ambiguous: false };
}

interface CoveredSymbol {
  symbol: RankedSymbol;
  concepts: Set<string>;
}

/**
 * Which concepts explain which symbols.
 *
 * A file-level anchor covers every symbol in the file: concepts are written
 * about files far more often than about single functions, and treating a file
 * anchor as covering only itself would put every symbol of an explained file
 * back on the backlog. Broken anchors cover nothing — they explain code that
 * is no longer there.
 *
 * A LINE-RANGE anchor covers only the symbols that fit inside it. A ten-line
 * citation must not claim a 500-line module, and — the case this exists for — a
 * range sitting inside one big function claims nothing at all, because naming
 * the enclosing function would make the concept responsible for every call that
 * function makes. Staleness is unaffected: the range goes straight to the clock
 * without passing through coverage, so a sub-function citation is still watched.
 */
function buildCoverage(
  anchors: ResolvedAnchor[],
  byFile: Map<string, RankedSymbol[]>
): Map<string, CoveredSymbol> {
  const coverage = new Map<string, CoveredSymbol>();
  const cover = (symbol: RankedSymbol, concept: string): void => {
    const key = symbolKey(symbol.file, symbol.name);
    const entry = coverage.get(key);
    if (entry) entry.concepts.add(concept);
    else coverage.set(key, { symbol, concepts: new Set([concept]) });
  };

  for (const anchor of anchors) {
    if (anchor.resolution !== "ok") continue;
    const inFile = byFile.get(anchor.path);
    if (!inFile) continue;
    if (anchor.symbol === null) {
      const range = anchor.lines;
      for (const symbol of inFile) {
        if (range && (symbol.start_line < range.start || symbol.end_line > range.end)) continue;
        cover(symbol, anchor.concept);
      }
      continue;
    }
    const { hit } = findNamedSymbol(inFile, anchor.symbol);
    if (hit) cover(hit, anchor.concept);
  }
  return coverage;
}

/** The later of two ISO timestamps, ignoring nulls and unparseable values. */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return bMs > aMs ? b : a;
}

/**
 * Concepts whose code has moved since the knowledge was last confirmed.
 *
 * The baseline is the LATER of what the author declared and when the concept
 * file itself was last committed. The declared timestamp alone is not enough:
 * knowledge is normally written in the same commit as the code it explains, so
 * the declaration is always a little older than that commit and every fresh
 * concept would report stale. It is also hand-written, and therefore wrong
 * sooner or later. The file's own commit date is objective and moves whenever
 * anyone touches the note — including to re-attest it.
 */
function findStale(anchors: ResolvedAnchor[], clock: CodeClock, now: Date): {
  stale: StaleFinding[];
  unattested: string[];
} {
  const stale: StaleFinding[] = [];
  const unattested = new Set<string>();
  const reported = new Set<string>();

  for (const anchor of anchors) {
    // A broken anchor has no meaningful commit date. Asking anyway would
    // double-report one problem and bury which fix is actually needed.
    if (anchor.resolution !== "ok") continue;
    if (anchor.attestedAt === null) unattested.add(anchor.concept);
    if (reported.has(anchor.concept)) continue;

    // `stale_after` is a declared shelf life, independent of whether the code
    // moved — checked first so an expired concept is reported once even if it
    // would also qualify as code-changed below.
    if (anchor.staleAfter !== null) {
      const expiry = Date.parse(anchor.staleAfter);
      if (!Number.isNaN(expiry) && expiry <= now.getTime()) {
        reported.add(anchor.concept);
        stale.push({
          concept: anchor.concept,
          resource: anchor.resource,
          path: anchor.path,
          attestedAt: anchor.attestedAt,
          changedAt: null,
          reason: "expired",
          expiresAt: anchor.staleAfter,
          range: anchor.range,
        });
        continue;
      }
    }

    // An author mid-edit already knows: both the note and the code are in flux,
    // and this is the exact work that resolves the drift.
    const conceptChange = clock.lastChanged(anchor.conceptPath, null);
    if (conceptChange.uncommitted) continue;

    const baseline = laterOf(anchor.attestedAt, conceptChange.at);
    if (baseline === null) continue;

    const change = clock.lastChanged(anchor.path, anchor.range);
    // Uncommitted work is invisible to a commit clock: whatever date it returns
    // describes older code, so the concept cannot be trusted yet.
    const reason: StaleFinding["reason"] | null = change.uncommitted
      ? "uncommitted"
      : change.at !== null && Date.parse(change.at) > Date.parse(baseline)
        ? "code-changed"
        : null;
    if (!reason) continue;

    reported.add(anchor.concept);
    stale.push({
      concept: anchor.concept,
      resource: anchor.resource,
      path: anchor.path,
      attestedAt: baseline,
      changedAt: change.at,
      reason,
      range: anchor.range,
    });
  }

  return { stale, unattested: [...unattested] };
}

/** Directory names that mark a test tree. Matched as whole segments, never as substrings. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
/** Filename infixes every mainstream runner uses to mark a test file. */
const TEST_INFIXES = [".test.", ".spec.", "_test.", "_spec."];

/**
 * Whether a path belongs to the test tree.
 *
 * Segment-exact, because substring matching would quietly swallow real code:
 * `src/latest/release.ts` contains "test" and would vanish from the backlog with
 * nobody the wiser.
 */
function looksLikeTest(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (TEST_INFIXES.some((infix) => name.includes(infix))) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment));
}

/**
 * Highest-ranked symbols no concept explains — a documentation backlog in
 * priority order.
 *
 * Test symbols are excluded. PageRank ranks test helpers highly because every
 * case calls them, but a helper has no *why* to record, and proposing them
 * buries the real gaps. This is the ONLY place tests are filtered: a concept
 * explaining a test is legitimate knowledge, so anchor and staleness checks
 * treat test files like any other.
 */
function findCoverageGaps(
  ranked: RankedSymbol[],
  coverage: Map<string, CoveredSymbol>,
  limit: number
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const symbol of ranked) {
    if (gaps.length >= limit) break;
    if (looksLikeTest(symbol.file)) continue;
    if (coverage.has(symbolKey(symbol.file, symbol.name))) continue;
    gaps.push({ name: symbol.name, kind: symbol.kind, file: symbol.file, rank: symbol.rank });
  }
  return gaps;
}

/**
 * Concept pairs whose code calls across them but whose prose never does.
 *
 * Only anchored symbols are probed for callers, so this costs one query per
 * explained symbol rather than one per symbol in the repo. A caller is matched
 * on file AND name, so an unrelated namesake elsewhere cannot invent an edge —
 * but the `coverage` map itself is still keyed by file+name (`symbolKey`), so
 * two same-named symbols in the SAME file are still conflated into one entry
 * here. `resolveAnchor` now warns about this ambiguity for the anchor that
 * named them (see `AuditReport.ambiguous`), but that warning is about which
 * anchor resolves to which symbol, not about this map's key collision.
 */
function inferLinks(
  bundle: Bundle,
  graph: AuditGraph,
  coverage: Map<string, CoveredSymbol>
): LinkSuggestion[] {
  const bodies = new Map(bundle.files.map((f) => [f.path, f.document.body]));
  // A pair already connected in prose is connected. Nagging about which
  // direction the link points would turn a real signal into a style complaint.
  const alreadyLinked = (a: string, b: string): boolean =>
    (bodies.get(a) ?? "").includes(b) || (bodies.get(b) ?? "").includes(a);

  const links: LinkSuggestion[] = [];
  const seen = new Set<string>();

  for (const { symbol: callee, concepts: calleeConcepts } of coverage.values()) {
    for (const caller of graph.findCallers(callee.name)) {
      const callerEntry = coverage.get(symbolKey(caller.path, caller.name));
      if (!callerEntry) continue;

      for (const from of callerEntry.concepts) {
        for (const to of calleeConcepts) {
          if (from === to) continue;
          // An edge whose BOTH ends are already explained by BOTH concepts says
          // nothing about a relationship they lack. Two concepts anchoring the
          // same file cover an identical symbol set, so every call inside that
          // file would otherwise produce a suggestion — in both directions.
          if (callerEntry.concepts.has(to) && calleeConcepts.has(from)) continue;
          // Unordered key: direction is not what the suggestion is about, and
          // `alreadyLinked` ignores it too. Mutual recursion across two files
          // would otherwise report the same pair twice.
          const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
          if (seen.has(key)) continue;
          if (alreadyLinked(from, to)) continue;
          seen.add(key);
          links.push({ from, to, because: { caller: caller.name, callee: callee.name } });
        }
      }
    }
  }
  return links;
}

export function auditBundle(bundle: Bundle, layout: BundleLayout, deps: AuditDeps): AuditReport {
  const { ranked, byFile } = deps.symbols ?? readSymbols(deps.graph);
  const resolutions = collectAnchors(bundle, layout).map((a) => resolveAnchor(a, byFile, deps.exists));
  const anchors = resolutions.map((r) => r.resolved);
  const ambiguous: AmbiguousAnchor[] = resolutions
    .filter((r) => r.ambiguous)
    .map((r) => ({
      concept: r.resolved.concept,
      resource: r.resolved.resource,
      path: r.resolved.path,
      symbol: r.resolved.symbol as string,
    }));
  const coverage = buildCoverage(anchors, byFile);
  const { stale, unattested } = findStale(anchors, deps.clock, deps.now ?? new Date());

  return {
    anchors,
    broken: anchors.filter((a) => a.resolution !== "ok"),
    stale,
    judged: [],
    unattested,
    ambiguous,
    coverage: findCoverageGaps(ranked, coverage, deps.coverageLimit ?? DEFAULT_COVERAGE_LIMIT),
    links: inferLinks(bundle, deps.graph, coverage),
  };
}

/**
 * Which concepts to re-read after a symbol changes.
 *
 * The changed symbol's own explanations come first — they are the ones most
 * likely to be wrong now — followed by the explanations of everything that
 * transitively calls it, since a behaviour change propagates up the call graph
 * whether or not those files were edited.
 */
export function impactedConcepts(
  symbol: string,
  bundle: Bundle,
  layout: BundleLayout,
  deps: {
    graph: AuditGraph;
    exists(repoRelPath: string): boolean;
    /** Reuse a symbol table `auditBundle` already built, instead of a second `pageRank()`. */
    symbols?: SymbolTable;
    /** Reuse anchors `auditBundle` already resolved (its `report.anchors`), skipping a second resolve pass. */
    anchors?: ResolvedAnchor[];
  }
): ImpactedConcept[] {
  const { ranked, byFile } = deps.symbols ?? readSymbols(deps.graph);
  const anchors =
    deps.anchors ?? collectAnchors(bundle, layout).map((a) => resolveAnchor(a, byFile, deps.exists).resolved);
  const coverage = buildCoverage(anchors, byFile);

  const touched: { name: string; file: string }[] = [
    ...ranked.filter((s) => s.name === symbol).map((s) => ({ name: s.name, file: s.file })),
    ...deps.graph.impact(symbol).map((hit) => ({ name: hit.name, file: hit.path })),
  ];

  const impacted: ImpactedConcept[] = [];
  const seen = new Set<string>();
  for (const via of touched) {
    const entry = coverage.get(symbolKey(via.file, via.name));
    if (!entry) continue;
    for (const concept of entry.concepts) {
      if (seen.has(concept)) continue;
      seen.add(concept);
      impacted.push({ concept, via });
    }
  }
  return impacted;
}
