/**
 * Code-aware query expansion for the lexical (BM25) search floor.
 *
 * Pure, synchronous, no I/O. Improves lexical recall over raw code queries by:
 *  1. Splitting camelCase / snake_case / kebab-case identifiers into their
 *     word parts and appending them to the query (never replacing).
 *  2. Expanding a small curated set of code abbreviations/synonyms,
 *     bidirectionally, append-only.
 *
 * Always append, never replace — the original query text is preserved
 * verbatim so BM25 still matches exact identifiers too.
 */

/** Bidirectional code abbreviation/synonym pairs. Expansion-only, small and curated. */
const CODE_SYNONYM_PAIRS: Array<[string, string]> = [
  ["auth", "authentication"],
  ["cfg", "config"],
  ["config", "configuration"],
  ["btn", "button"],
  ["throttle", "rate limit"],
  ["db", "database"],
  ["msg", "message"],
  ["err", "error"],
  ["fn", "function"],
  ["func", "function"],
  ["repo", "repository"],
  ["dir", "directory"],
  ["init", "initialize"],
  ["async", "asynchronous"],
  ["sync", "synchronous"],
  ["impl", "implementation"],
  ["ctx", "context"],
  ["env", "environment"],
  ["req", "request"],
  ["res", "response"],
  ["resp", "response"],
  ["arg", "argument"],
  ["param", "parameter"],
  ["auth", "authorization"],
  ["pkg", "package"],
  ["dep", "dependency"],
  ["deps", "dependencies"],
  ["util", "utility"],
  ["utils", "utilities"],
  ["lib", "library"],
  ["src", "source"],
  ["dest", "destination"],
  ["idx", "index"],
  ["obj", "object"],
  ["arr", "array"],
  ["str", "string"],
  ["num", "number"],
  ["bool", "boolean"],
  ["temp", "temporary"],
];

const CODE_SYNONYMS: Map<string, string[]> = buildSynonymMap(CODE_SYNONYM_PAIRS);

function buildSynonymMap(pairs: Array<[string, string]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    addSynonym(map, a, b);
    addSynonym(map, b, a);
  }
  return map;
}

function addSynonym(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** Split a single token into its identifier word parts (camelCase/snake_case/kebab-case). */
function splitIdentifier(token: string): string[] {
  if (!token) return [];

  // snake_case / kebab-case first: split on _ and -
  const segments = token.split(/[_-]+/).filter(Boolean);

  const parts: string[] = [];
  for (const segment of segments) {
    // camelCase / PascalCase: insert boundary before an uppercase letter that
    // follows a lowercase/digit, and before an uppercase letter that starts a
    // new word after a run of uppercase letters (e.g. "HTTPServer" -> HTTP Server).
    const withBoundaries = segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const p of withBoundaries.split(/\s+/).filter(Boolean)) {
      parts.push(p.toLowerCase());
    }
  }
  return parts;
}

/** True if the token contains an identifier-style boundary worth splitting. */
function hasIdentifierBoundary(token: string): boolean {
  return /[_-]/.test(token) || /[a-z0-9][A-Z]/.test(token) || /[A-Z]{2,}[a-z]/.test(token);
}

/**
 * Expand a raw search query with code-aware preprocessing for the lexical
 * (BM25) floor. Always appends to the original query — never replaces it —
 * so exact-term matches on the raw text are preserved.
 *
 * Safe on empty, whitespace-only, and punctuation-only input (returns the
 * input unchanged in those cases, never throws).
 */
export function expandQuery(raw: string): string {
  if (typeof raw !== "string") return "";

  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return raw;

  const additions: string[] = [];
  const seen = new Set<string>(tokens.map((t) => t.toLowerCase()));

  const addUnique = (word: string): void => {
    const lower = word.toLowerCase();
    if (!lower || seen.has(lower)) return;
    seen.add(lower);
    additions.push(word);
  };

  const applySynonyms = (word: string): void => {
    const synonyms = CODE_SYNONYMS.get(word.toLowerCase());
    if (synonyms) {
      for (const syn of synonyms) addUnique(syn);
    }
  };

  for (const token of tokens) {
    // Strip surrounding punctuation for matching purposes, keep the core word.
    const core = token.replace(/^[^\w-]+|[^\w-]+$/g, "");
    if (!core) continue;

    let splitParts: string[] = [];
    if (hasIdentifierBoundary(core)) {
      splitParts = splitIdentifier(core);
      for (const part of splitParts) {
        addUnique(part);
      }
    }

    // Synonym lookup on the whole token, plus each split part (so e.g.
    // "getUserAuth" -> split "auth" part still triggers auth<->authentication).
    applySynonyms(core);
    for (const part of splitParts) {
      applySynonyms(part);
    }
  }

  // Multi-word synonym keys (e.g. "rate limit" <-> "throttle") can't match a
  // single whitespace-split token, so also scan the full lowercased query.
  const lowerTrimmed = trimmed.toLowerCase();
  for (const [key, synonyms] of CODE_SYNONYMS) {
    if (!key.includes(" ")) continue;
    if (lowerTrimmed.includes(key)) {
      for (const syn of synonyms) addUnique(syn);
    }
  }

  if (additions.length === 0) return raw;
  return `${raw} ${additions.join(" ")}`;
}
