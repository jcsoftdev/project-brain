/**
 * One colour theme, described once. Every surface project-brain paints (the terminal, Claude Code itself with its diff,
 * the activity pane, Neovim) is generated from this, so adding a theme is adding one definition, never touching an adapter.
 * All colours are `#rrggbb`.
 */
export interface ThemeDefinition {
  id: string;
  label: string;
  /** What the terminal paints behind everything. */
  background: string;
  foreground: string;
  /** The current line, the selection and raised surfaces. */
  selection: string;
  /** Secondary text. */
  comment: string;
  accents: {
    red: string;
    orange: string;
    yellow: string;
    green: string;
    cyan: string;
    purple: string;
    pink: string;
  };
  /** The 16 terminal colours, in ANSI order (0-7 normal, 8-15 bright). */
  ansi: readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
}
