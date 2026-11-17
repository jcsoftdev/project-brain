import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyBlock, blockState, readTextOrEmpty, removeBlock, stateWithoutTool, type BlockMarkers } from "./managed-block.js";
import { uiRolesOf, type UiRoles } from "../themes/roles.js";
import { themeById, type ThemeDefinition } from "../themes/index.js";

/**
 * The "Tokyo Night + Dracula" composition as a managed block at the end of the user's tmux config.
 *
 * tmux keeps the last value of a repeated option, so the block wins over what the user set above it, and removing it
 * hands every option back. Areas meant to show the translucent terminal through use `default`; only raised layers
 * (messages, selections, pills) get a background of their own.
 */
export const TMUX_THEME_BEGIN = "# >>> project-brain tmux theme >>>";
export const TMUX_THEME_END = "# <<< project-brain tmux theme <<<";

const MARKERS: BlockMarkers = { begin: TMUX_THEME_BEGIN, end: TMUX_THEME_END };

export type TmuxThemeState = "absent" | "current" | "stale" | "foreign" | "unavailable";

export type Which = (command: string) => string | null;

const style = (fg: string, bg = "default", ...attributes: string[]): string =>
  [`fg=${fg}`, `bg=${bg}`, ...attributes].join(",");

/** Option name to value, in the order they are written; every colour is `#rrggbb` or `default`. */
export function tmuxOptionsOf(roles: UiRoles): Array<[string, string]> {
  const { surface, text, border, accent, status } = roles;
  const pill = (bg: string) => style(text.onAccent, bg, "bold");
  return [
    ["status-style", style(text.muted)],
    ["status-left-style", style(text.muted)],
    ["status-right-style", style(text.hint)],
    ["status-left", `#[${pill(accent.purple)}]#{?client_prefix,#[bg=${status.progress}],} #S #[default] `],
    ["window-status-separator", ""],
    ["window-status-format", " #I:#W#{window_flags} "],
    ["window-status-current-format", " #I:#W#{window_flags} "],
    ["window-status-style", style(text.muted)],
    ["window-status-current-style", pill(border.focus)],
    ["window-status-activity-style", style(status.progress)],
    ["window-status-bell-style", style(status.error, "default", "bold")],
    ["pane-border-style", style(border.idle)],
    ["pane-active-border-style", style(border.focus)],
    ["message-style", style(text.fg, surface.float)],
    ["message-command-style", style(text.fg, surface.float)],
    ["mode-style", style(text.fg, surface.selection)],
    ["copy-mode-selection-style", style(text.fg, surface.selection)],
    ["copy-mode-match-style", style(text.fg, surface.search)],
    ["copy-mode-current-match-style", style(text.onAccent, surface.searchCurrent)],
    ["copy-mode-mark-style", style(text.onAccent, accent.purple)],
    ["popup-border-style", style(border.idle)],
    ["menu-border-style", style(border.idle)],
    ["menu-selected-style", style(text.fg, surface.selection)],
    ["clock-mode-colour", border.focus],
    ["display-panes-active-colour", border.focus],
    ["display-panes-colour", border.idle],
  ];
}

const quoted = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function tmuxThemeBlockOf(theme: ThemeDefinition = themeById()): string {
  return [
    TMUX_THEME_BEGIN,
    `# ${theme.label}`,
    ...tmuxOptionsOf(uiRolesOf(theme)).map(([name, value]) => `set -g ${name} ${quoted(value)}`),
    TMUX_THEME_END,
  ].join("\n");
}

/**
 * tmux loads every user config that exists, in this order, so the last existing one has the final word; with none,
 * a new file goes where tmux 3.2+ looks without a dotfile in the home directory.
 */
export function tmuxConfigPath(home: string, xdgConfigHome?: string): string {
  const xdg = xdgConfigHome ? join(xdgConfigHome, "tmux", "tmux.conf") : undefined;
  const fallback = join(home, ".config", "tmux", "tmux.conf");
  const candidates = [join(home, ".tmux.conf"), ...(xdg ? [xdg] : []), fallback];
  const existing = candidates.filter((one) => existsSync(one));
  return existing[existing.length - 1] ?? xdg ?? fallback;
}

export async function tmuxThemeState(
  path: string,
  theme: ThemeDefinition = themeById(),
  which: Which = Bun.which
): Promise<TmuxThemeState> {
  const state = blockState(await readTextOrEmpty(path), MARKERS, tmuxThemeBlockOf(theme));
  return which("tmux") ? state : stateWithoutTool(state);
}

export const applyTmuxTheme = (path: string, theme: ThemeDefinition = themeById()): Promise<void> =>
  applyBlock(path, MARKERS, tmuxThemeBlockOf(theme));

export const removeTmuxTheme = (path: string): Promise<void> => removeBlock(path, MARKERS);

export const tmuxReloadHint = (path: string): string =>
  `tmux theme written to ${path}; a running tmux picks it up with: tmux source-file ${path}`;
