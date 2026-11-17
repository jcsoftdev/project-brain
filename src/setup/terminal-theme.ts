import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyBlock, blockState, readTextOrEmpty, removeBlock, withBlock, withoutBlock, type BlockMarkers } from "./managed-block.js";
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

const MARKERS: BlockMarkers = { begin: TERMINAL_THEME_BEGIN, end: TERMINAL_THEME_END };

export const terminalThemeState = (text: string, theme: ThemeDefinition = themeById()): TerminalThemeState =>
  blockState(text, MARKERS, terminalThemeBlockOf(theme));

export const withTerminalTheme = (text: string, theme: ThemeDefinition = themeById()): string =>
  withBlock(text, MARKERS, terminalThemeBlockOf(theme));

export const withoutTerminalTheme = (text: string): string => withoutBlock(text, MARKERS);

export const readTerminalConfig = readTextOrEmpty;

export const applyTerminalTheme = (path: string, theme: ThemeDefinition = themeById()): Promise<void> =>
  applyBlock(path, MARKERS, terminalThemeBlockOf(theme));

export const removeTerminalTheme = (path: string): Promise<void> => removeBlock(path, MARKERS);
