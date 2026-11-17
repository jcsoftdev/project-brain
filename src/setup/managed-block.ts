import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";

/**
 * A block of lines this tool owns inside a file that belongs to the user, found by whole marker lines.
 *
 * A marker with no partner (a begin without its end, a stray end, a begin inside a block) is not something this module
 * wrote, so the file is reported `foreign` and left alone: guessing where such a block ends would delete the user's lines.
 */
export interface BlockMarkers {
  begin: string;
  end: string;
}

export type BlockState = "absent" | "current" | "stale" | "foreign";

/**
 * A unit's state once its tool is gone: what it wrote still reports `current` or `stale`, so the owner can untick it
 * and have it removed; with nothing of its own on disk there is nothing to offer, and it is `unavailable`.
 */
export const stateWithoutTool = <S extends string>(state: S): S | "unavailable" =>
  state === "current" || state === "stale" ? state : "unavailable";

type Span = { start: number; end: number };

/** Lines keep their own trailing CR, so a file that mixes LF and CRLF comes back with every line ending as it was. */
const linesOf = (text: string): string[] => text.split("\n");
const bare = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);
const isCrlf = (text: string): boolean => {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf * 2 >= text.split("\n").length - 1;
};
const joined = (lines: string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

function scan(lines: string[], markers: BlockMarkers): { blocks: Span[]; isBroken: boolean } {
  const blocks: Span[] = [];
  let open: number | null = null;
  let isBroken = false;
  lines.forEach((line, index) => {
    const text = bare(line);
    if (text === markers.begin) {
      if (open !== null) isBroken = true;
      open = index;
    } else if (text === markers.end) {
      if (open === null) isBroken = true;
      else blocks.push({ start: open, end: index });
      open = null;
    }
  });
  return { blocks, isBroken: isBroken || open !== null };
}

export function blockState(text: string, markers: BlockMarkers, expected: string): BlockState {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines, markers);
  if (isBroken) return "foreign";
  const only = blocks[0];
  if (only === undefined) return "absent";
  const same = blocks.length === 1 && lines.slice(only.start, only.end + 1).map(bare).join("\n") === expected;
  return same ? "current" : "stale";
}

/** The lines left once every block, and the one blank line this tool put in front of it, is gone. */
function withoutBlocks(lines: string[], blocks: Span[]): string[] {
  const dropped = new Set<number>();
  for (const { start, end } of blocks) {
    for (let at = start; at <= end; at++) dropped.add(at);
    if (start > 0 && lines[start - 1]!.trim() === "" && !dropped.has(start - 1)) dropped.add(start - 1);
    // A block that opened the file has no blank line before it to take along, so take the one after it.
    if (start === 0) for (let at = end + 1; at < lines.length && lines[at]!.trim() === "" && at < lines.length - 1; at++) dropped.add(at);
  }
  const kept = lines.filter((_, index) => !dropped.has(index));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept;
}

/** The text with exactly one block at its end; nothing outside the block changes. A file with an unpaired marker comes back as it was. */
export function withBlock(text: string, markers: BlockMarkers, block: string): string {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines, markers);
  if (isBroken) return text;
  const kept = withoutBlocks(lines, blocks);
  const cr = isCrlf(text) ? "\r" : "";
  return joined([...kept, ...(kept.length > 0 ? [cr] : []), ...block.split("\n").map((line) => `${line}${cr}`)]);
}

/** The text without any block; a file that only held the block comes back empty, one with an unpaired marker as it was. */
export function withoutBlock(text: string, markers: BlockMarkers): string {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines, markers);
  if (isBroken || blocks.length === 0) return text;
  return joined(withoutBlocks(lines, blocks));
}

/** The file's text; a missing file is empty, any other failure (permissions, I/O) is an error, never an empty file. */
export async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Where a write to `path` lands: a symlinked file is written through, never replaced by a regular file.
 *
 * A link whose target is missing (a dotfiles checkout moved, a volume not mounted) is refused rather than followed:
 * creating its target could build a fresh tree where a mount point belongs, and writing over the link loses it.
 */
export async function writeTargetOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const link = await lstat(path).catch(() => null);
    if (link?.isSymbolicLink()) {
      throw new Error(`${path} is a symlink to ${await readlink(path)}, which does not exist; restore it or remove the link, then run setup again`);
    }
    return path;
  }
}

/** Writes `text` atomically to `path`, through a symlink when `path` is one. */
export async function writeThroughLink(path: string, text: string): Promise<void> {
  const target = await writeTargetOf(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFileAtomic(target, text);
}

const write = writeThroughLink;

export async function applyBlock(path: string, markers: BlockMarkers, block: string): Promise<void> {
  const before = await readTextOrEmpty(path);
  const after = withBlock(before, markers, block);
  if (after !== before) await write(path, after);
}

export async function removeBlock(path: string, markers: BlockMarkers): Promise<void> {
  if (!existsSync(path)) return;
  const before = await readTextOrEmpty(path);
  const after = withoutBlock(before, markers);
  if (after !== before) await write(path, after);
}
