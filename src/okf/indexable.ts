import { stripSection } from "../markers.js";
import type { BundleFile } from "./bundle.js";

/**
 * Module every OKF concept is filed under in the vector store.
 *
 * Concepts are namespaced rather than mixed anonymously into the code chunks so
 * they stay separable: browsable on their own via list_modules/get_module, and
 * attachable to code by the anchor layer later, without a knowledge document
 * ever out-ranking the code itself on a "where is X" lookup.
 */
export const OKF_MODULE = "okf";

export interface IndexableConcept {
  /**
   * Store source id — the file's real repo-relative path.
   *
   * It must match what the regular indexer would use for the same file
   * (`sync.ts` files everything under `entry.relPath`), because both write to
   * the same table. A synthetic prefix would either collide with a real path or
   * invent one that does not exist, and it would break the anchoring that reads
   * a concept's location back off the store.
   */
  source: string;
  module: string;
  /** Preamble + curated prose, ready to be chunked and embedded. */
  content: string;
}

/**
 * Projects a bundle concept into the form the store indexes.
 *
 * The managed block is removed first. It holds derived facts — anchors, line
 * ranges, call edges — that the structural tools answer faster and never
 * staler; indexing it would duplicate code-shaped text into the semantic index
 * and let it compete with the curated prose that is the point of the bundle.
 *
 * Returns null for anything that is not knowledge: reserved navigation files,
 * reference material, and concepts whose body is nothing but a managed block.
 *
 * `source` defaults to the bundle-relative path, but callers that know where
 * the bundle sits in the repo MUST pass the real repo-relative path so the id
 * matches the one the regular indexer uses for that same file.
 */
export function conceptToIndexable(
  file: BundleFile,
  source: string = file.path
): IndexableConcept | null {
  if (file.kind !== "concept") return null;

  const { type, title, tags, status } = file.document.frontmatter;
  // §11 forbids rejecting a document over optional fields, unknown types or
  // broken links — `type` is none of those. Without it the concept cannot be
  // labelled or reasoned about, and indexing it regardless would make a
  // non-conformant file work well enough that its frontmatter never gets fixed.
  // The validator reports it; this skips it.
  if (typeof type !== "string" || type.trim() === "") return null;

  const prose = stripSection(file.document.body).trim();
  if (prose === "") return null;
  // `stable` is the spec default (§5.4) and says nothing useful; draft and
  // deprecated do, and must travel with the text so retrieved guidance is not
  // mistaken for current.
  const label = status && status !== "stable" ? `${type} · ${status}` : type;
  const heading = `[${label}] ${title ?? file.path}`;
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `tags: ${tags.join(", ")}` : null;

  return {
    source,
    module: OKF_MODULE,
    content: [heading, tagLine, "", prose].filter((l) => l !== null).join("\n"),
  };
}
