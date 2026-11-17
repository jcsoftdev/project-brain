import { blend, lighten } from "./color.js";
import { uiRolesOf } from "./roles.js";
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
 * with these and not with anything a plugin can paint. The /diff rows and changed words are the same mix Neovim paints
 * its diffs with (`uiRolesOf`), so a diff reads the same in both.
 */
export function claudeCodeThemeOf(theme: ThemeDefinition): ClaudeCodeTheme {
  const { background: bg, foreground: fg, selection, comment, accents: a } = theme;
  const { surface, text, diff } = uiRolesOf(theme);
  const raised = (share: number) => blend(bg, selection, share);
  return {
    name: `Project Brain · ${theme.label}`,
    base: "dark",
    overrides: {
      claude: a.pink,
      claudeShimmer: lighten(a.pink),
      text: text.fg,
      inverseText: bg,
      inactive: text.muted,
      inactiveShimmer: blend(comment, fg, 0.55),
      subtle: text.hint,
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

      diffAdded: diff.add,
      diffRemoved: diff.delete,
      diffAddedDimmed: diff.addDim,
      diffRemovedDimmed: diff.deleteDim,
      diffAddedWord: diff.textAdd,
      diffRemovedWord: diff.textDelete,

      userMessageBackground: surface.float,
      userMessageBackgroundHover: raised(0.8),
      bashMessageBackgroundColor: raised(0.35),
      memoryBackgroundColor: surface.float,
      selectionBg: surface.selection,
      composerSidebarBackground: surface.base,

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
