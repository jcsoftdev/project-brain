import { mkdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { themeById, type ThemeDefinition } from "../themes/index.js";

/**
 * The active theme (see src/themes) as a managed block in the user's Ghostty config, so the terminal and the activity pane
 * (which paints the same palette) agree. Supacode embeds Ghostty and merges this same file.
 * Ghostty keeps the last value of a repeated key, so the block goes at the end and wins over what the user
 * wrote above it; removing it hands every key back without the rest of the file having been touched.
 *
 * The block is found by whole marker lines. A marker with no partner (a begin without its end, a stray end,
 * a begin inside a block) is not something this module wrote, so the file is reported `foreign` and left alone:
 * guessing where such a block ends would delete the user's own lines.
 */
export const TERMINAL_THEME_BEGIN = "# >>> project-brain terminal theme >>>";
export const TERMINAL_THEME_END = "# <<< project-brain terminal theme <<<";

/** Translucent enough to see the desktop through, blurred enough to keep text readable. */
export const TERMINAL_OPACITY = 0.88;
export const TERMINAL_BLUR = 20;

const bare = (hex: string): string => hex.replace(/^#/, "");

/** The block for a theme: its colours, then the opacity and blur the pane is drawn for. */
export function terminalThemeBlockOf(theme: ThemeDefinition = themeById()): string {
  return [
    TERMINAL_THEME_BEGIN,
    `# ${theme.label}`,
    `background = ${bare(theme.background)}`,
    `foreground = ${bare(theme.foreground)}`,
    `selection-background = ${bare(theme.selection)}`,
    `selection-foreground = ${bare(theme.foreground)}`,
    `cursor-color = ${bare(theme.foreground)}`,
    `cursor-text = ${bare(theme.background)}`,
    ...theme.ansi.map((hex, index) => `palette = ${index}=${hex}`),
    `background-opacity = ${TERMINAL_OPACITY}`,
    `background-blur = ${TERMINAL_BLUR}`,
    // Tabs, pills and diff rows are cells with a background of their own; without this they stay opaque.
    "background-opacity-cells = true",
    TERMINAL_THEME_END,
  ].join("\n");
}

export const TERMINAL_THEME_BLOCK = terminalThemeBlockOf();

/** The Ghostty config the user already has, else the platform's default location for a new one. */
export function ghosttyConfigPath(home: string, platform: NodeJS.Platform = process.platform): string {
  const candidates = [
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config.ghostty"),
    join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
    join(home, ".config", "ghostty", "config.ghostty"),
    join(home, ".config", "ghostty", "config"),
  ];
  const existing = candidates.find((one) => existsSync(one));
  if (existing) return existing;
  return platform === "darwin" ? candidates[0]! : candidates[2]!;
}

export type TerminalThemeState = "absent" | "current" | "stale" | "foreign";

/** Where each well-formed block sits (inclusive line indexes); `isBroken` when a marker has no partner. */
function scan(lines: string[]): { blocks: Array<{ start: number; end: number }>; isBroken: boolean } {
  const blocks: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  let isBroken = false;
  lines.forEach((line, index) => {
    if (line === TERMINAL_THEME_BEGIN) {
      if (open !== null) isBroken = true;
      open = index;
    } else if (line === TERMINAL_THEME_END) {
      if (open === null) isBroken = true;
      else blocks.push({ start: open, end: index });
      open = null;
    }
  });
  return { blocks, isBroken: isBroken || open !== null };
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");
const linesOf = (text: string): string[] => text.split(/\r?\n/);

export function terminalThemeState(text: string, theme: ThemeDefinition = themeById()): TerminalThemeState {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines);
  if (isBroken) return "foreign";
  const only = blocks[0];
  if (only === undefined) return "absent";
  const same = blocks.length === 1 && lines.slice(only.start, only.end + 1).join("\n") === terminalThemeBlockOf(theme);
  return same ? "current" : "stale";
}

/** The lines left once every block, and the one blank line setup put in front of it, is gone. */
function withoutBlocks(lines: string[], blocks: Array<{ start: number; end: number }>): string[] {
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

const join_ = (lines: string[], eol: string): string => (lines.length === 0 ? "" : `${lines.join(eol)}${eol}`);

/** The text with exactly one block at its end; nothing outside the block changes. A file with an unpaired marker comes back as it was. */
export function withTerminalTheme(text: string, theme: ThemeDefinition = themeById()): string {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines);
  if (isBroken) return text;
  const kept = withoutBlocks(lines, blocks);
  return join_([...kept, ...(kept.length > 0 ? [""] : []), ...terminalThemeBlockOf(theme).split("\n")], eolOf(text));
}

/** The text without any block; a file that only held the block comes back empty, one with an unpaired marker as it was. */
export function withoutTerminalTheme(text: string): string {
  const lines = linesOf(text);
  const { blocks, isBroken } = scan(lines);
  if (isBroken || blocks.length === 0) return text;
  return join_(withoutBlocks(lines, blocks), eolOf(text));
}

/** The file's text; a missing file is empty, any other failure (permissions, I/O) is an error, never an empty file. */
export async function readTerminalConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** A symlinked config is written through, not replaced by a regular file. */
const targetOf = (path: string): Promise<string> => realpath(path).catch(() => path);

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(await targetOf(path), text);
}

export async function applyTerminalTheme(path: string, theme: ThemeDefinition = themeById()): Promise<void> {
  const before = await readTerminalConfig(path);
  const after = withTerminalTheme(before, theme);
  if (after !== before) await write(path, after);
}

export async function removeTerminalTheme(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const before = await readTerminalConfig(path);
  const after = withoutTerminalTheme(before);
  if (after !== before) await write(path, after);
}
