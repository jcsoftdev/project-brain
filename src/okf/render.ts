import { stringify as stringifyYaml } from "yaml";
import type { OkfDocument, OkfFrontmatter } from "./types.js";

/**
 * Canonical frontmatter key order: required first (§4), then the recommended
 * descriptive fields, then lifecycle, then the provenance/trust families (§5).
 * Unrecognized keys are emitted after these, alphabetically.
 *
 * The order is fixed on purpose. The exporter re-renders every concept on every
 * sync; if output depended on key insertion order, each run would churn the
 * whole bundle in git.
 */
const KEY_ORDER = [
  "okf_version",
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  "stale_after",
  "sources",
  "generated",
  "verified",
] as const;

/** Drops keys the spec would rather see absent than empty. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

/** Reorders frontmatter into canonical order so rendering is insertion-order independent. */
function canonicalize(frontmatter: OkfFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (!isEmpty(frontmatter[key])) out[key] = frontmatter[key];
  }
  const known = new Set<string>(KEY_ORDER);
  const extra = Object.keys(frontmatter)
    .filter((k) => !known.has(k) && !isEmpty(frontmatter[k]))
    .sort();
  for (const key of extra) out[key] = frontmatter[key];
  return out;
}

/**
 * Renders an OKF concept document to markdown.
 *
 * Pure function of the document's logical content — two documents that mean the
 * same thing produce identical bytes. A document with empty frontmatter renders
 * as a bare body, which is what the reserved `index.md` / `log.md` files need
 * (§8, §9: no frontmatter, except the bundle-root `okf_version`).
 */
export function renderDocument(doc: OkfDocument): string {
  const frontmatter = canonicalize(doc.frontmatter);
  const body = `${doc.body.trim()}\n`;
  if (Object.keys(frontmatter).length === 0) return body;

  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body}`;
}
