import { parseDocument } from "./frontmatter.js";

/**
 * OKF v0.2 §11 conformance checking.
 *
 * The rule set is deliberately tiny, and staying tiny is the point: the spec
 * explicitly forbids rejecting a document for missing optional fields, unknown
 * types, unrecognized keys, or broken links. Anything beyond the three
 * structural rules below is soft guidance and belongs in the audit step, which
 * reports rather than fails.
 */

export type OkfRule =
  | "frontmatter-required"
  | "type-required"
  | "index-frontmatter-forbidden"
  | "log-date-format";

export interface OkfIssue {
  /** Bundle-relative path of the offending file. */
  path: string;
  rule: OkfRule;
  message: string;
}

const RESERVED = new Set(["index.md", "log.md"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True for the bundle-root index.md, the only file allowed to declare okf_version (§12). */
function isRootIndex(path: string): boolean {
  return path === "index.md" || path === "./index.md";
}

/**
 * Validates one bundle file against §11.
 * Returns an empty array when the file conforms.
 */
export function validateFile(path: string, raw: string): OkfIssue[] {
  const name = basename(path);
  if (name === "index.md") return validateIndex(path, raw);
  if (name === "log.md") return validateLog(path, raw);
  if (RESERVED.has(name)) return [];
  return validateConcept(path, raw);
}

function validateConcept(path: string, raw: string): OkfIssue[] {
  const hasBlock = /^---\r?\n/.test(raw);
  const { frontmatter } = parseDocument(raw);

  if (!hasBlock || Object.keys(frontmatter).length === 0) {
    return [{
      path,
      rule: "frontmatter-required",
      message: "Concept documents MUST open with a parseable YAML frontmatter block (§11.1).",
    }];
  }

  const type = frontmatter.type;
  if (typeof type !== "string" || type.trim() === "") {
    return [{
      path,
      rule: "type-required",
      message: "Frontmatter MUST contain a non-empty `type` (§11.2).",
    }];
  }

  return [];
}

function validateIndex(path: string, raw: string): OkfIssue[] {
  const { frontmatter } = parseDocument(raw);
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return [];

  // §8: index.md carries no frontmatter — except the bundle root, which MAY
  // declare the version the bundle targets.
  const allowed = isRootIndex(path) && keys.length === 1 && keys[0] === "okf_version";
  if (allowed) return [];

  return [{
    path,
    rule: "index-frontmatter-forbidden",
    message: isRootIndex(path)
      ? "The bundle-root index.md may only carry `okf_version` in frontmatter (§8, §12)."
      : "index.md MUST NOT carry frontmatter (§8).",
  }];
}

function validateLog(path: string, raw: string): OkfIssue[] {
  const issues: OkfIssue[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/);
    if (!heading) continue;
    const date = heading[1] ?? "";
    if (!ISO_DATE.test(date)) {
      issues.push({
        path,
        rule: "log-date-format",
        message: `log.md date headings MUST use ISO 8601 YYYY-MM-DD (§9); found "${date}".`,
      });
    }
  }
  return issues;
}
