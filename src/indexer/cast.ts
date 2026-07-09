import type { Boundary } from "../parser/extract.js";

/**
 * cAST-style AST-aware chunking (arxiv 2506.15655, reference impl
 * github.com/yilinjz/astchunk). Chunks are derived from real tree-sitter AST
 * declaration boundaries instead of regex/brace-counting: adjacent sibling
 * nodes are greedily merged into a chunk until the next node would exceed
 * the budget; a single node that alone exceeds the budget is recursively
 * split via its own children.
 *
 * Budget metric: NON-WHITESPACE characters (the paper's setting), not raw
 * length — a whitespace-heavy node (blank lines, deep indentation) does not
 * trigger an early split just because its raw byte count is large.
 */
export const CAST_MAX_NON_WHITESPACE_CHARS = 2000;

export interface Section {
  content: string;
  symbol_name?: string;
  symbol_kind?: string;
  signature?: string;
  start_line?: number;
  end_line?: number;
}

/** Count non-whitespace characters — the budget metric, per the paper. */
function nonWhitespaceLength(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (!/\s/.test(s[i]!)) count++;
  }
  return count;
}

function firstLineSignature(content: string): string {
  return content.split("\n")[0]!.slice(0, 160);
}

function lineOf(source: string, index: number): number {
  // 1-indexed line number of byte offset `index` within `source`.
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/** Build a Section from a raw byte span [start, end) of `source`. */
function sectionFromSpan(
  source: string,
  start: number,
  end: number,
  meta?: { name: string; kind: string },
): Section {
  const content = source.slice(start, end);
  return {
    content,
    symbol_name: meta?.name,
    symbol_kind: meta?.kind,
    signature: meta ? firstLineSignature(source.slice(start, end)) : undefined,
    start_line: lineOf(source, start),
    end_line: lineOf(source, Math.max(start, end - 1)),
  };
}

/**
 * Recursively split a single oversized boundary node into sections using its
 * direct children (the next depth level, restricted to this node's byte
 * range). If it has no children (a leaf that is itself over budget, e.g. a
 * giant single function body), it is returned as one atomic section — there
 * is nothing smaller in the AST to split it further.
 */
function splitOversizedNode(
  source: string,
  node: Boundary,
  allBoundaries: Boundary[],
): Section[] {
  const children = allBoundaries
    .filter(
      (b) =>
        b !== node &&
        b.depth === node.depth + 1 &&
        b.start_index >= node.start_index &&
        b.end_index <= node.end_index,
    )
    .sort((a, b) => a.start_index - b.start_index);

  if (children.length === 0) {
    // Nothing smaller to split by — emit the whole node as one section.
    return [sectionFromSpan(source, node.start_index, node.end_index, { name: node.name, kind: node.kind })];
  }

  return greedyMerge(source, node.start_index, node.end_index, children, allBoundaries);
}

/**
 * Greedy sequential merge over a sibling boundary list spanning
 * [rangeStart, rangeEnd) of `source`. Leading gap text before a boundary
 * (imports, top-level statements, inter-node whitespace) joins the
 * FOLLOWING node's chunk. Adjacent nodes are merged into the same chunk
 * while under budget; a node that alone exceeds budget is recursively split
 * via its own children.
 */
function greedyMerge(
  source: string,
  rangeStart: number,
  rangeEnd: number,
  siblings: Boundary[],
  allBoundaries: Boundary[],
): Section[] {
  const sections: Section[] = [];

  // Accumulator for the chunk currently being built: a contiguous byte span
  // plus the metadata of the LAST boundary node merged into it (cAST/most
  // chunkers report the trailing/primary symbol when multiple nodes merge).
  let accStart: number | null = null;
  let accEnd = rangeStart;
  let accMeta: { name: string; kind: string } | undefined;

  function flush(endAt: number) {
    if (accStart === null) return;
    sections.push(sectionFromSpan(source, accStart, endAt, accMeta));
    accStart = null;
    accMeta = undefined;
  }

  let cursor = rangeStart;

  for (const node of siblings) {
    const gapStart = cursor;
    const gapEnd = node.start_index;
    const candidateStart = accStart ?? gapStart;
    const candidateEnd = node.end_index;
    const candidateText = source.slice(candidateStart, candidateEnd);

    if (nonWhitespaceLength(candidateText) <= CAST_MAX_NON_WHITESPACE_CHARS) {
      // Fits — merge gap + node into the current accumulator.
      accStart = candidateStart;
      accEnd = candidateEnd;
      accMeta = { name: node.name, kind: node.kind };
    } else {
      // Adding this node would exceed budget.
      // First, flush whatever was already accumulated (gap text before this
      // node stays attached to the flushed chunk's tail — but per spec,
      // leading gap text joins the FOLLOWING node, so instead we flush up to
      // gapStart and let this node's own chunk absorb [gapStart, node.end)).
      flush(gapStart);

      const soloText = source.slice(gapStart, candidateEnd);
      if (nonWhitespaceLength(soloText) <= CAST_MAX_NON_WHITESPACE_CHARS) {
        // Node alone (with its leading gap) fits — start a fresh accumulator.
        accStart = gapStart;
        accEnd = candidateEnd;
        accMeta = { name: node.name, kind: node.kind };
      } else {
        // Node alone still exceeds budget — recursively split IT via its
        // children. Any leading gap text attaches to the first sub-section.
        const subSections = splitOversizedNode(source, node, allBoundaries);
        if (subSections.length > 0 && gapStart < node.start_index) {
          const gapText = source.slice(gapStart, node.start_index);
          subSections[0] = {
            ...subSections[0],
            content: gapText + subSections[0].content,
            start_line: lineOf(source, gapStart),
          };
        }
        sections.push(...subSections);
        accStart = null;
        accEnd = candidateEnd;
        accMeta = undefined;
      }
    }

    cursor = node.end_index;
  }

  // Trailing gap after the last sibling (up to rangeEnd) attaches to the
  // final accumulated chunk, or becomes a standalone chunk if nothing was
  // accumulated (shouldn't normally happen with non-empty siblings, but
  // covers a trailing-only-gap edge case safely).
  if (cursor < rangeEnd) {
    if (accStart !== null) {
      accEnd = rangeEnd;
    } else {
      sections.push(sectionFromSpan(source, cursor, rangeEnd));
      cursor = rangeEnd;
    }
  }

  flush(accEnd);

  return sections;
}

/**
 * cAST-style AST-aware chunker. Given full file `content` and its
 * AST declaration boundaries (from src/parser/extract.ts's
 * extractBoundaries), greedily merges adjacent top-level nodes into chunks
 * under the non-whitespace-character budget, recursively splitting any
 * single node that alone exceeds it via its children.
 *
 * When `boundaries` is empty (markdown, unsupported languages, parse
 * failures, oversize-skipped files), returns the whole content as one
 * section — callers should treat this as "no AST info available" and fall
 * back to the legacy regex/brace-counting chunker instead of calling this
 * function at all; this fallback exists so castChunk itself never loses
 * bytes even if called with no boundaries.
 *
 * No-byte-loss guarantee: concatenating every returned section's `content`
 * in order reproduces `content` exactly.
 */
export function castChunk(content: string, boundaries: Boundary[]): Section[] {
  if (boundaries.length === 0) {
    return [{ content }];
  }

  const topLevel = boundaries
    .filter((b) => b.depth === 0)
    .sort((a, b) => a.start_index - b.start_index);

  if (topLevel.length === 0) {
    return [{ content }];
  }

  return greedyMerge(content, 0, content.length, topLevel, boundaries);
}
