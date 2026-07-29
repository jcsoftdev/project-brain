import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseDocument } from "./frontmatter.js";
import { validateFile } from "./validate.js";
import type { OkfIssue } from "./validate.js";
import type { OkfDocument } from "./types.js";

/**
 * Reading an OKF bundle off disk (§2: the distribution unit is a directory of
 * markdown files, shippable as a git repo, tarball, or subdirectory).
 */

export class OkfBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkfBundleError";
  }
}

/**
 * `concept` files carry knowledge. The rest are structure:
 *  - `index`/`log` are reserved navigation and history (§8, §9),
 *  - `reference` is anything under `references/`, which mirrors external
 *    material, scripts, or code (§6.2).
 * Only concepts are validated as concepts and only concepts are worth indexing;
 * conflating them would report false conformance errors on files that are not
 * supposed to have frontmatter at all.
 */
export type BundleFileKind = "concept" | "index" | "log" | "reference";

export interface BundleFile {
  /** Bundle-relative path, always POSIX-separated. */
  path: string;
  kind: BundleFileKind;
  raw: string;
  document: OkfDocument;
}

export interface Bundle {
  root: string;
  /** Version declared by the bundle-root index.md, or null when undeclared (§12). */
  okfVersion: string | null;
  files: BundleFile[];
  issues: OkfIssue[];
}

const REFERENCES_DIR = "references";

export function classifyBundleFile(path: string): BundleFileKind {
  if (path === REFERENCES_DIR || path.startsWith(`${REFERENCES_DIR}/`)) return "reference";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "index.md") return "index";
  if (name === "log.md") return "log";
  return "concept";
}

/** Depth-first walk yielding bundle-relative POSIX paths of every markdown file. */
async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    // Dot-directories are tooling, not knowledge: .git alone would otherwise
    // pull thousands of files into the bundle.
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, rel)));
    else if (entry.name.toLowerCase().endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * Reads and classifies every markdown file in a bundle.
 *
 * Never throws on file content: conformance problems are collected in `issues`
 * so a single malformed document cannot abort the walk — the same tolerance
 * §11 demands of consumers. A missing bundle root IS thrown, because that is a
 * caller mistake (bad path) rather than bad data.
 */
export async function readBundle(root: string): Promise<Bundle> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) throw new OkfBundleError(`Bundle root is not a directory: ${root}`);
  } catch (error) {
    if (error instanceof OkfBundleError) throw error;
    throw new OkfBundleError(`Bundle root does not exist: ${root}`);
  }

  const paths = (await walk(root)).sort();
  const files: BundleFile[] = [];
  const issues: OkfIssue[] = [];

  for (const path of paths) {
    const raw = await readFile(join(root, path.split("/").join(sep)), "utf-8");
    const kind = classifyBundleFile(path);
    files.push({ path, kind, raw, document: parseDocument(raw) });
    // `references/` is external material, not a concept — validating it would
    // report conformance errors on files the spec never asked to conform.
    if (kind !== "reference") issues.push(...validateFile(path, raw));
  }

  const rootIndex = files.find((f) => f.path === "index.md");
  const declared = rootIndex?.document.frontmatter.okf_version;

  return {
    root,
    okfVersion: typeof declared === "string" ? declared : null,
    files,
    issues,
  };
}
