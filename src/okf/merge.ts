import { DEFAULT_SECTION_ID, extractSection, replaceSection } from "../markers.js";
import type { OkfDocument, OkfFrontmatter } from "./types.js";

/**
 * Frontmatter fields the exporter derives from the index and rewrites on every
 * sync. A human editing these is editing a value that will be overwritten.
 */
const BRAIN_OWNED = ["type", "title", "resource", "sources"] as const;

/**
 * Fields a human (or the enrichment skill) owns. The exporter may seed them on
 * first generation, but once present they are never clobbered — this is what
 * makes "regenerate the whole bundle" a safe operation.
 */
const HUMAN_OWNED = ["description", "tags", "status", "stale_after", "verified"] as const;

export interface MergeOptions {
  /** ISO-8601 timestamp used for `generated.at` when derived content changed. */
  now: string;
  /** Body seeded above the managed block on first generation only. */
  curatedStub?: string;
  sectionId?: string;
}

/**
 * Reduces a document to the parts the brain derives, so two versions can be
 * compared for real change. Deliberately excludes `generated` (whose timestamp
 * is the thing being decided) and every human-owned field.
 */
function derivedFingerprint(frontmatter: OkfFrontmatter, derivedBody: string): string {
  const owned = BRAIN_OWNED.map((key) => [key, frontmatter[key] ?? null]);
  return JSON.stringify([owned, derivedBody]);
}

/**
 * Merges a freshly derived concept document into whatever is already on disk.
 *
 * Ownership is split by field and by body region: brain-owned frontmatter and
 * the managed block are replaced, human-owned frontmatter and prose outside the
 * block survive untouched. `generated.at` only advances when something derived
 * actually changed, so a no-op sync produces byte-identical output and leaves
 * the git diff empty.
 *
 * A stale `verified` attestation is intentionally preserved rather than dropped:
 * §11 asks consumers to surface failing attestations, not silently delete them.
 * Flagging it is the audit step's job, not the merge's.
 */
export function mergeDocument(
  generated: OkfDocument,
  existing: OkfDocument | null,
  options: MergeOptions
): OkfDocument {
  const sectionId = options.sectionId ?? DEFAULT_SECTION_ID;
  const derivedBody = generated.body.trim();

  if (!existing) {
    const base = options.curatedStub?.trim() ?? "";
    return {
      frontmatter: { ...generated.frontmatter, generated: attestation(generated, options.now) },
      body: replaceSection(base, derivedBody, sectionId),
    };
  }

  // Assembled through the index signature: iterating a union of literal keys
  // narrows the assignment target to an intersection of their value types,
  // which no single value can satisfy.
  const merged: Record<string, unknown> = { ...existing.frontmatter };
  for (const key of BRAIN_OWNED) {
    const value = generated.frontmatter[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  for (const key of HUMAN_OWNED) {
    const value = generated.frontmatter[key];
    if (existing.frontmatter[key] === undefined && value !== undefined) merged[key] = value;
  }

  const frontmatter = merged as OkfFrontmatter;
  const unchanged =
    derivedFingerprint(existing.frontmatter, extractSection(existing.body, sectionId) ?? "") ===
    derivedFingerprint(frontmatter, derivedBody);

  frontmatter.generated = unchanged
    ? existing.frontmatter.generated ?? attestation(generated, options.now)
    : attestation(generated, options.now);

  return { frontmatter, body: replaceSection(existing.body, derivedBody, sectionId) };
}

function attestation(generated: OkfDocument, now: string) {
  return { by: generated.frontmatter.generated?.by ?? "project-brain", at: now };
}
