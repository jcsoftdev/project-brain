import { basename } from "node:path";
import {
  DEFAULT_SECTION_ID,
  hasSectionMarkers,
  replaceSection,
  stripSection,
} from "../markers.js";

/**
 * Filesystem side of the managed-block convention. The string operations live
 * in src/markers.ts so the OKF exporter shares exactly one marker format.
 */

/**
 * What a `writeSection` call actually changed — an agent reported `okf init`
 * silently rewriting 51 lines of CLAUDE.md, with no way to tell that from the
 * one-line "created/skipped" summary the command printed. Callers surface
 * this instead of staying quiet about a file they just rewrote.
 */
export interface SectionWriteSummary {
  /** The path passed to writeSection. */
  file: string;
  linesAdded: number;
  linesRemoved: number;
  /** True when the file's bytes did not change at all (write was a no-op). */
  unchanged: boolean;
  /**
   * True when the text OUTSIDE the managed block is byte-identical before and
   * after — asserted here, not assumed, so a future template bug that leaks
   * into human-authored content is caught rather than silently shipped.
   */
  outsideBlockUnchanged: boolean;
}

/**
 * Line-level diff, counted the way `git diff --numstat` would: each line
 * present in `oldText` but not matched in `newText` (by longest common
 * subsequence) is a removal, and vice versa for additions. Good enough for
 * managed-block sizes (tens to low hundreds of lines) — O(n*m) DP.
 */
function diffLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
  const newLines = newText.length > 0 ? newText.split("\n") : [];

  const n = oldLines.length;
  const m = newLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  return { added: m - lcs[0][0], removed: n - lcs[0][0] };
}

/**
 * Write content between section markers in a file.
 * If markers already exist, replace the section. Otherwise append.
 * Independent sections (different sectionId) coexist in the same file.
 */
export async function writeSection(
  filePath: string,
  content: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<SectionWriteSummary> {
  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    // File doesn't exist yet
  }

  const rendered = replaceSection(existing, content, sectionId);
  // Normalize to exactly one trailing newline rather than always appending
  // one — appending unconditionally meant every no-op rewrite (identical
  // content) still grew the file by one newline, which would have made
  // `unchanged` lie on the very case it exists to report.
  const next = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  await Bun.write(filePath, next);

  const { added, removed } = diffLineCounts(existing, next);
  return {
    file: filePath,
    linesAdded: added,
    linesRemoved: removed,
    unchanged: existing === next,
    outsideBlockUnchanged: outsideBlockText(existing, sectionId) === outsideBlockText(next, sectionId),
  };
}

/**
 * The non-managed portion of `text`, normalized the same way whether or not
 * the block is present yet — `stripSection` only trims when it finds a block
 * to remove, so comparing its raw output before/after a first-ever write
 * would report a false mismatch from trailing-whitespace differences alone.
 */
function outsideBlockText(text: string, sectionId: string): string {
  return hasSectionMarkers(text, sectionId) ? stripSection(text, sectionId) : text.trim();
}

/**
 * One line describing what a `writeSection` call changed — printed by every
 * command that rewrites a managed block (project-brain init, okf init), so
 * the rewrite is never silent again.
 */
export function formatSectionWriteSummary(summary: SectionWriteSummary): string {
  const name = basename(summary.file);
  if (summary.unchanged) return `${name}: unchanged`;

  const delta = `${name}: project-brain block updated (+${summary.linesAdded} −${summary.linesRemoved})`;
  return summary.outsideBlockUnchanged
    ? `${delta}; content outside the block unchanged`
    : `${delta}; WARNING: content outside the block changed`;
}

/**
 * Remove the section identified by sectionId from a file.
 * Returns true if a section was found and removed, false otherwise.
 */
export async function removeSection(
  filePath: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<boolean> {
  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    return false;
  }

  if (!hasSectionMarkers(existing, sectionId)) return false;

  await Bun.write(filePath, `${stripSection(existing, sectionId)}\n`);
  return true;
}

/** Returns true if the section identified by sectionId is present in the file. */
export async function hasSection(
  filePath: string,
  sectionId = DEFAULT_SECTION_ID
): Promise<boolean> {
  try {
    return hasSectionMarkers(await Bun.file(filePath).text(), sectionId);
  } catch {
    return false;
  }
}
