import { classifyBundleFile } from "./bundle.js";
import { parseDocument } from "./frontmatter.js";
import { conceptToIndexable, OKF_MODULE } from "./indexable.js";

/**
 * What the regular indexer should do with a file it just read.
 *
 *  - `null`      → not in the bundle; index it the normal way.
 *  - `{skip}`    → in the bundle but not knowledge; do not index it at all.
 *  - otherwise   → index this content under this module instead of the raw file.
 */
export type OkfRoute = { skip: false; content: string; module: string } | { skip: true } | null;

/** Default bundle location, relative to the repository root. */
export const DEFAULT_OKF_DIR = "okf";

function insideBundle(relPath: string, okfDir: string): boolean {
  // Prefix-with-separator, never a bare startsWith: "okf-drafts/notes.md"
  // starts with "okf" but is a different directory entirely.
  return relPath === okfDir || relPath.startsWith(`${okfDir}/`);
}

/**
 * Decides how the indexer handles one file.
 *
 * Both pipelines key chunks by the same repo-relative path, so without this
 * decision they overwrite each other: a plain sync would chunk the bundle file
 * raw — frontmatter as prose, managed block included, no type label — and
 * replace the curated projection. Since the git hook runs sync on commit, that
 * happened every time the bundle was committed, which is precisely when it was
 * least likely to be noticed.
 *
 * Anything inside the bundle that is not an indexable concept is skipped rather
 * than allowed to fall through to the raw path, which would re-create the same
 * collision under a directory-derived module.
 */
export function routeOkfFile(relPath: string, content: string, okfDir: string = DEFAULT_OKF_DIR): OkfRoute {
  if (!insideBundle(relPath, okfDir)) return null;
  if (!relPath.toLowerCase().endsWith(".md")) return { skip: true };

  const bundlePath = relPath.slice(okfDir.length + 1);
  const kind = classifyBundleFile(bundlePath);
  const indexable = conceptToIndexable(
    { path: bundlePath, kind, raw: content, document: parseDocument(content) },
    relPath
  );
  if (!indexable) return { skip: true };

  return { skip: false, content: indexable.content, module: OKF_MODULE };
}
