import { parse as parseYaml } from "yaml";
import type { OkfDocument, OkfFrontmatter } from "./types.js";

/**
 * Matches a frontmatter block that starts at byte 0: `---` on its own line,
 * the YAML payload, then a closing `---` on its own line. Anything after is body.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/**
 * Splits an OKF concept document into frontmatter and markdown body.
 *
 * Tolerant by contract (§11): a missing or malformed YAML block yields an empty
 * frontmatter rather than an error, so a single bad file can never abort a
 * bundle walk. Structural conformance is reported by the validator, not here.
 */
export function parseDocument(raw: string): OkfDocument {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const body = raw.slice(match[0].length).trim();
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { frontmatter: {}, body };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: {}, body };
  }

  return { frontmatter: normalize(parsed as OkfFrontmatter), body };
}

/**
 * Applies the normalizations the spec demands of every consumer, so callers
 * never have to branch on shape. Today that is §11's rule that a bare
 * `verified` mapping MUST be treated as a single-element list.
 */
function normalize(frontmatter: OkfFrontmatter): OkfFrontmatter {
  const { verified } = frontmatter;
  if (verified && !Array.isArray(verified)) {
    return { ...frontmatter, verified: [verified] };
  }
  return frontmatter;
}
