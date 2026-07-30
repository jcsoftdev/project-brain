import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Bundle } from "./bundle.js";
import type { OkfFrontmatter } from "./types.js";

/**
 * Anchors: the join between the curated knowledge graph and the derived code
 * graph.
 *
 * A concept says *why* something is the way it is; the call graph says *what*
 * the code does. Neither can answer "is this explanation still true?" alone.
 * An anchor is a concept's claim about a specific place in the repo, which is
 * what lets the two graphs be compared at all.
 */

export interface ParsedResource {
  /** Path as written, before it is resolved against the bundle root. */
  path: string;
  symbol: string | null;
  lines: { start: number; end: number } | null;
}

export interface Anchor {
  /** Bundle-relative path of the concept that declares the anchor. */
  concept: string;
  /**
   * The concept's OWN repo-relative path.
   *
   * `attestedAt` is author-declared and easy to get wrong; this file's commit
   * date is objective, and lands in the same commit as the code whenever the
   * two are written together — which is how knowledge normally gets recorded.
   */
  conceptPath: string;
  /** The resource string exactly as authored, for reporting back to the author. */
  resource: string;
  /** Repo-relative POSIX path — the same key the graph's `files` table uses. */
  path: string;
  symbol: string | null;
  lines: { start: number; end: number } | null;
  origin: "resource" | "sources";
  /** Newest attestation on the concept, or null when it has never been attested. */
  attestedAt: string | null;
}

export interface BundleLayout {
  /** Absolute path of the bundle directory. */
  bundleRoot: string;
  /** Absolute path of the repository the bundle documents. */
  repoRoot: string;
}

/** `scheme:` prefix — a URI, not a path. Two or more letters so a bare `C:` stays a path. */
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;
const LINE_RANGE_RE = /^L(\d+)(?:-L?(\d+))?$/;

/**
 * Splits a resource into path plus optional fragment.
 *
 * Fragments follow the two conventions a reader already expects from a code
 * host: `#symbolName` and `#L10-L25`. Returns null for anything that is not a
 * local path — external URLs are legitimate OKF provenance (§5.1), they are
 * simply not anchors into this repo.
 */
export function parseResource(resource: string): ParsedResource | null {
  const trimmed = resource.trim();
  if (trimmed === "" || URI_SCHEME_RE.test(trimmed)) return null;

  const hash = trimmed.indexOf("#");
  const path = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
  const fragment = hash === -1 ? "" : trimmed.slice(hash + 1).trim();
  if (path === "") return null;
  if (fragment === "") return { path, symbol: null, lines: null };

  const range = fragment.match(LINE_RANGE_RE);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    // A backwards or zero-based range is a typo. Falling through to the symbol
    // branch would look up a "symbol" named `L25-L10`, which silently resolves
    // to nothing and reads as a missing anchor instead of a broken one.
    if (start < 1 || end < start) return null;
    return { path, symbol: null, lines: { start, end } };
  }

  return { path, symbol: fragment, lines: null };
}

/**
 * Resolves a resource path against the bundle root and re-expresses it as the
 * repo-relative POSIX key the graph uses.
 *
 * The base is the bundle ROOT, not the document's directory, matching the
 * root-relative link convention the bundle already uses in prose
 * (`/decisions/x.md`). Returns null when the result escapes the repo, since
 * nothing outside it is in the graph and reporting it unresolved would be noise.
 */
function toRepoPath(rawPath: string, layout: BundleLayout): string | null {
  const absolute = resolve(layout.bundleRoot, rawPath);
  const rel = relative(layout.repoRoot, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** ISO timestamp of the newest attestation, whichever field carries it. */
function newestAttestation(frontmatter: OkfFrontmatter): string | null {
  const candidates: string[] = [];
  const generated = frontmatter.generated;
  if (generated && typeof generated.at === "string") candidates.push(generated.at);
  if (Array.isArray(frontmatter.verified)) {
    for (const entry of frontmatter.verified) {
      if (entry && typeof entry === "object" && typeof entry.at === "string") candidates.push(entry.at);
    }
  }

  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const at of candidates) {
    const ms = Date.parse(at);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
    newest = at;
  }
  return newest;
}

/** Every resource a concept declares, in authoring order: `resource`, then `sources[]`. */
function declaredResources(frontmatter: OkfFrontmatter): { resource: string; origin: Anchor["origin"] }[] {
  const out: { resource: string; origin: Anchor["origin"] }[] = [];
  if (typeof frontmatter.resource === "string") {
    out.push({ resource: frontmatter.resource, origin: "resource" });
  }
  if (Array.isArray(frontmatter.sources)) {
    for (const source of frontmatter.sources) {
      // §11: bad optional data must not reject the document, so a malformed
      // entry is skipped rather than thrown on.
      if (!source || typeof source !== "object") continue;
      if (typeof source.resource !== "string") continue;
      out.push({ resource: source.resource, origin: "sources" });
    }
  }
  return out;
}

/**
 * Collects every repo anchor declared by the bundle's concepts.
 *
 * Only concepts anchor code: `index.md` and `log.md` are navigation, and
 * `references/` is external material (§6.2). Anything that does not resolve to
 * a path inside the repo is dropped here rather than carried as an unresolved
 * anchor, so downstream findings are about code, never about URLs.
 */
export function collectAnchors(bundle: Bundle, layout: BundleLayout): Anchor[] {
  const anchors: Anchor[] = [];
  for (const file of bundle.files) {
    if (file.kind !== "concept") continue;
    const attestedAt = newestAttestation(file.document.frontmatter);
    const conceptPath = toRepoPath(file.path, layout);
    if (conceptPath === null) continue;

    for (const { resource, origin } of declaredResources(file.document.frontmatter)) {
      const parsed = parseResource(resource);
      if (!parsed) continue;
      const path = toRepoPath(parsed.path, layout);
      if (path === null) continue;
      anchors.push({
        concept: file.path,
        conceptPath,
        resource,
        path,
        symbol: parsed.symbol,
        lines: parsed.lines,
        origin,
        attestedAt,
      });
    }
  }
  return anchors;
}
