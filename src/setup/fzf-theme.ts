import { basename, join } from "node:path";
import { applyBlock, blockState, readTextOrEmpty, removeBlock, withBlock, withoutBlock, type BlockMarkers } from "./managed-block.js";
import { themeById, uiRolesOf, type ThemeDefinition } from "../themes/index.js";

/**
 * The active theme for fzf, as a managed block at the end of the shell rc that appends one `--color` option to
 * `FZF_DEFAULT_OPTS`. fzf merges repeated `--color` options with the later one winning, so every option the user set
 * stays and only the slots named here are painted. The block is guarded by `command -v fzf`, so it does nothing on a
 * machine without fzf.
 *
 * `FZF_DEFAULT_OPTS_FILE` was the alternative: it names one file, so taking it would replace a file the user may
 * already point it at, and fzf reads it before `FZF_DEFAULT_OPTS`, so the rc would still need an export.
 */
export const FZF_THEME_BEGIN = "# >>> project-brain fzf theme >>>";
export const FZF_THEME_END = "# <<< project-brain fzf theme <<<";

const MARKERS: BlockMarkers = { begin: FZF_THEME_BEGIN, end: FZF_THEME_END };

/** fzf's "default terminal colour": the translucent window shows through instead of a solid panel. */
const TERMINAL_DEFAULT = "-1";

/** Each fzf colour slot and its value, in the order fzf's man page lists them. */
export function fzfColorsOf(theme: ThemeDefinition = themeById()): ReadonlyArray<readonly [slot: string, value: string]> {
  const { text, picker, border } = uiRolesOf(theme);
  return [
    ["fg", text.fg],
    ["bg", TERMINAL_DEFAULT],
    ["gutter", TERMINAL_DEFAULT],
    ["hl", picker.match],
    ["fg+", `${text.fg}:bold`],
    ["bg+", picker.row],
    ["hl+", picker.match],
    ["query", `${text.fg}:regular`],
    ["info", picker.info],
    ["border", border.idle],
    ["list-border", border.idle],
    ["preview-border", border.idle],
    ["input-border", border.input],
    ["separator", border.idle],
    ["scrollbar", border.idle],
    ["label", `${border.focus}:bold`],
    ["prompt", picker.prompt],
    ["pointer", picker.pointer],
    ["marker", picker.marker],
    ["spinner", picker.spinner],
    ["header", picker.header],
  ];
}

export const fzfColorOptionOf = (theme: ThemeDefinition = themeById()): string =>
  `--color=${fzfColorsOf(theme)
    .map(([slot, value]) => `${slot}:${value}`)
    .join(",")}`;

export function fzfThemeBlockOf(theme: ThemeDefinition = themeById()): string {
  return [
    FZF_THEME_BEGIN,
    `# ${theme.label}`,
    "if command -v fzf >/dev/null 2>&1; then",
    `  export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPTS ${fzfColorOptionOf(theme)}"`,
    "fi",
    FZF_THEME_END,
  ].join("\n");
}

/**
 * The rc an interactive shell of the user's login shell reads: `$ZDOTDIR/.zshrc` (else `~/.zshrc`) for zsh, `~/.bashrc`
 * for bash. Any other shell has no rc this block's syntax fits, so it gets none.
 */
export function fzfRcPath(home: string, shell: string | undefined, zdotdir?: string): string | null {
  const name = shell ? basename(shell) : "";
  if (name === "zsh") return join(zdotdir || home, ".zshrc");
  if (name === "bash") return join(home, ".bashrc");
  return null;
}

export type FzfThemeState = "absent" | "current" | "stale" | "foreign" | "unavailable";

export type Which = (command: string) => string | null;

export interface FzfThemeTarget {
  /** Null when the user's shell is not one the block is written for. */
  rcPath: string | null;
  which?: Which;
  theme?: ThemeDefinition;
}

export const fzfThemeStateOf = (text: string, theme: ThemeDefinition = themeById()): Exclude<FzfThemeState, "unavailable"> =>
  blockState(text, MARKERS, fzfThemeBlockOf(theme));

export const withFzfTheme = (text: string, theme: ThemeDefinition = themeById()): string => withBlock(text, MARKERS, fzfThemeBlockOf(theme));

export const withoutFzfTheme = (text: string): string => withoutBlock(text, MARKERS);

export async function fzfThemeState({ rcPath, which = Bun.which, theme = themeById() }: FzfThemeTarget): Promise<FzfThemeState> {
  if (rcPath === null || which("fzf") === null) return "unavailable";
  return fzfThemeStateOf(await readTextOrEmpty(rcPath), theme);
}

export async function applyFzfTheme({ rcPath, which = Bun.which, theme = themeById() }: FzfThemeTarget): Promise<void> {
  if (rcPath === null || which("fzf") === null) return;
  await applyBlock(rcPath, MARKERS, fzfThemeBlockOf(theme));
}

export async function removeFzfTheme({ rcPath }: Pick<FzfThemeTarget, "rcPath">): Promise<void> {
  if (rcPath !== null) await removeBlock(rcPath, MARKERS);
}
