import { blend, lighten } from "./color.js";
import type { ThemeDefinition } from "./types.js";

/** What a Claude Code custom theme file holds: a name, the built-in theme it starts from, and the tokens it changes. */
export interface ClaudeCodeTheme {
  name: string;
  base: "dark" | "light";
  overrides: Record<string, string>;
}

/** The file name (and so the `custom:<slug>` reference) a theme gets under ~/.claude/themes. */
export const claudeCodeThemeSlug = (theme: ThemeDefinition): string => `project-brain-${theme.id}`;
export const claudeCodeThemeRef = (theme: ThemeDefinition): string => `custom:${claudeCodeThemeSlug(theme)}`;

/**
 * Claude Code's UI tokens for a theme: the chat, the prompt, permissions and the /diff view, which the engine draws
 * with these and not with anything a plugin can paint. Diff rows are the accent mixed into the background, so they stay
 * readable on a translucent terminal; the word-level highlight is a stronger mix of the same accent.
 */
export function claudeCodeThemeOf(theme: ThemeDefinition): ClaudeCodeTheme {
  const { background: bg, foreground: fg, selection, comment, accents: a } = theme;
  const tint = (accent: string, share: number) => blend(bg, accent, share);
  const raised = (share: number) => blend(bg, selection, share);
  return {
    name: `Project Brain · ${theme.label}`,
    base: "dark",
    overrides: {
      claude: a.pink,
      claudeShimmer: lighten(a.pink),
      text: fg,
      inverseText: bg,
      inactive: blend(comment, fg, 0.35),
      inactiveShimmer: blend(comment, fg, 0.55),
      subtle: comment,
      suggestion: a.cyan,
      permission: a.purple,
      permissionShimmer: lighten(a.purple),
      remember: a.purple,

      success: a.green,
      error: a.red,
      warning: a.orange,
      warningShimmer: lighten(a.orange),
      merged: a.purple,

      promptBorder: a.pink,
      promptBorderShimmer: lighten(a.pink),
      planMode: a.cyan,
      autoAccept: a.green,
      autoAcceptShimmer: lighten(a.green),
      bashBorder: a.orange,
      ide: a.cyan,
      fastMode: a.orange,
      fastModeShimmer: lighten(a.orange),
      effortUltra: a.purple,

      diffAdded: tint(a.green, 0.2),
      diffRemoved: tint(a.red, 0.2),
      diffAddedDimmed: tint(a.green, 0.12),
      diffRemovedDimmed: tint(a.red, 0.12),
      diffAddedWord: tint(a.green, 0.38),
      diffRemovedWord: tint(a.red, 0.38),

      userMessageBackground: raised(0.55),
      userMessageBackgroundHover: raised(0.8),
      bashMessageBackgroundColor: raised(0.35),
      memoryBackgroundColor: raised(0.55),
      selectionBg: selection,
      composerSidebarBackground: bg,

      briefLabelYou: a.cyan,
      briefLabelClaude: a.pink,

      rate_limit_fill: a.pink,
      rate_limit_empty: raised(0.8),

      red_FOR_SUBAGENTS_ONLY: a.red,
      blue_FOR_SUBAGENTS_ONLY: comment,
      green_FOR_SUBAGENTS_ONLY: a.green,
      yellow_FOR_SUBAGENTS_ONLY: a.yellow,
      purple_FOR_SUBAGENTS_ONLY: a.purple,
      orange_FOR_SUBAGENTS_ONLY: a.orange,
      pink_FOR_SUBAGENTS_ONLY: a.pink,
      cyan_FOR_SUBAGENTS_ONLY: a.cyan,
    },
  };
}

export const claudeCodeThemeText = (theme: ThemeDefinition): string => `${JSON.stringify(claudeCodeThemeOf(theme), null, 2)}\n`;
