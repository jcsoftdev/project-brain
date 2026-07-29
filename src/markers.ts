/**
 * Managed-block primitives, shared by the AI-rules writers (src/rules/) and the
 * OKF exporter (src/okf/).
 *
 *   <!-- project-brain:start -->
 *   ...machine-owned, regenerated on every sync...
 *   <!-- project-brain:end -->
 *
 * The split matters: content inside the block is derived and disposable,
 * content outside it is human-authored and MUST survive a rewrite. These
 * functions are pure so both the in-memory (OKF) and filesystem (rules) callers
 * agree on exactly one marker format.
 */

export const DEFAULT_SECTION_ID = "project-brain";

export function markers(sectionId: string = DEFAULT_SECTION_ID): { start: string; end: string } {
  return {
    start: `<!-- ${sectionId}:start -->`,
    end: `<!-- ${sectionId}:end -->`,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionRegex(sectionId: string): RegExp {
  const { start, end } = markers(sectionId);
  return new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`);
}

/** Returns the content between the markers, or null when the block is absent. */
export function extractSection(text: string, sectionId: string = DEFAULT_SECTION_ID): string | null {
  const { start, end } = markers(sectionId);
  const match = text.match(new RegExp(`${escapeRegex(start)}\\r?\\n?([\\s\\S]*?)\\r?\\n?${escapeRegex(end)}`));
  return match ? (match[1] ?? "") : null;
}

/** True when the managed block is present. */
export function hasSectionMarkers(text: string, sectionId: string = DEFAULT_SECTION_ID): boolean {
  return text.includes(markers(sectionId).start);
}

/**
 * Replaces the managed block with `content`, or appends it when absent.
 * Idempotent: replacing a block with identical content returns identical text,
 * which is what keeps regenerated bundles out of the git diff.
 */
export function replaceSection(
  text: string,
  content: string,
  sectionId: string = DEFAULT_SECTION_ID
): string {
  const { start, end } = markers(sectionId);
  const section = `${start}\n${content}\n${end}`;

  if (hasSectionMarkers(text, sectionId)) {
    return text.replace(sectionRegex(sectionId), section);
  }
  if (text.length === 0) return section;
  return `${text.replace(/\n+$/, "")}\n\n${section}`;
}

/** Removes the managed block, leaving only the human-authored remainder. */
export function stripSection(text: string, sectionId: string = DEFAULT_SECTION_ID): string {
  if (!hasSectionMarkers(text, sectionId)) return text;
  return text.replace(new RegExp(`\\n*${sectionRegex(sectionId).source}\\n*`), "\n").trim();
}
