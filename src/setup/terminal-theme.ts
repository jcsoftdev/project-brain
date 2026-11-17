import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Dracula theme as a managed block in the user's Ghostty config, so the terminal and the activity pane
 * (which paints the same palette) agree. Supacode embeds Ghostty and merges this same file.
 * Ghostty keeps the last value of a repeated key, so the block goes at the end and wins over what the user
 * wrote above it; removing it hands every key back without the rest of the file having been touched.
 */
export const TERMINAL_THEME_BEGIN = "# >>> project-brain terminal theme (Dracula) >>>";
export const TERMINAL_THEME_END = "# <<< project-brain terminal theme <<<";

/** Dracula's published colours, and its standard ANSI set. */
export const DRACULA_TERMINAL = {
  background: "17141d",
  foreground: "f8f8f2",
  selection: "44475a",
  palette: [
    "21222c", "ff5555", "50fa7b", "f1fa8c", "bd93f9", "ff79c6", "8be9fd", "f8f8f2",
    "6272a4", "ff6e6e", "69ff94", "ffffa5", "d6acff", "ff92df", "a4ffff", "ffffff",
  ],
} as const;

/** Translucent enough to see the desktop through, blurred enough to keep text readable. */
export const TERMINAL_OPACITY = 0.88;
export const TERMINAL_BLUR = 20;

export const TERMINAL_THEME_BODY = [
  `background = ${DRACULA_TERMINAL.background}`,
  `foreground = ${DRACULA_TERMINAL.foreground}`,
  `selection-background = ${DRACULA_TERMINAL.selection}`,
  `selection-foreground = ${DRACULA_TERMINAL.foreground}`,
  `cursor-color = ${DRACULA_TERMINAL.foreground}`,
  `cursor-text = ${DRACULA_TERMINAL.background}`,
  ...DRACULA_TERMINAL.palette.map((hex, index) => `palette = ${index}=#${hex}`),
  `background-opacity = ${TERMINAL_OPACITY}`,
  `background-blur = ${TERMINAL_BLUR}`,
].join("\n");

export const TERMINAL_THEME_BLOCK = `${TERMINAL_THEME_BEGIN}\n${TERMINAL_THEME_BODY}\n${TERMINAL_THEME_END}`;

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

const BLOCK = new RegExp(`\\n?${escape(TERMINAL_THEME_BEGIN)}[\\s\\S]*?${escape(TERMINAL_THEME_END)}\\n?`);
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TerminalThemeState = "absent" | "current" | "stale";

export function terminalThemeState(text: string): TerminalThemeState {
  const match = text.match(BLOCK);
  if (!match) return "absent";
  return match[0].trim() === TERMINAL_THEME_BLOCK ? "current" : "stale";
}

/** The text with the block written at its end (replacing a previous one); nothing outside the block changes. */
export function withTerminalTheme(text: string): string {
  const without = text.replace(BLOCK, "\n").trimEnd();
  return `${without === "" ? "" : `${without}\n\n`}${TERMINAL_THEME_BLOCK}\n`;
}

/** The text without the block; a file that only held the block comes back empty. */
export function withoutTerminalTheme(text: string): string {
  const rest = text.replace(BLOCK, "\n").trimEnd();
  return rest === "" ? "" : `${rest}\n`;
}

export async function readTerminalConfig(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

export async function applyTerminalTheme(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, withTerminalTheme(await readTerminalConfig(path)));
}

export async function removeTerminalTheme(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await writeFile(path, withoutTerminalTheme(await readTerminalConfig(path)));
}
