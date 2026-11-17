import { blend } from "./color.js";
import type { ThemeDefinition } from "./types.js";

/**
 * The "Tokyo Night + Dracula" mix: tokyonight's structure (layered surfaces, borders, a diff palette) painted with the
 * theme's colours. Every value matches what `templates/nvim/lua/project-brain/highlights.lua` computes, and a headless
 * Neovim test holds the two together. All colours are `#rrggbb`.
 */
export interface UiRoles {
  surface: {
    base: string;
    float: string;
    line: string;
    selection: string;
  };
  text: {
    fg: string;
    fgDim: string;
    gutter: string;
    comment: string;
    muted: string;
  };
  border: {
    idle: string;
    focus: string;
  };
  diff: {
    add: string;
    delete: string;
    change: string;
    text: string;
    textAdd: string;
    textDelete: string;
    deleteFiller: string;
    /** Claude Code's quieter /diff context rows; Neovim has no counterpart for this pair. */
    addDim: string;
    deleteDim: string;
  };
  git: {
    add: string;
    change: string;
    delete: string;
    ignore: string;
  };
  status: {
    error: string;
    warning: string;
    info: string;
    hint: string;
  };
  accent: ThemeDefinition["accents"];
}

export function uiRolesOf(theme: ThemeDefinition): UiRoles {
  const { background: bg, foreground: fg, selection, comment, accents: a } = theme;
  const tint = (accent: string, share: number) => blend(bg, accent, share);
  return {
    surface: {
      base: bg,
      float: tint(selection, 0.5),
      line: tint(selection, 0.45),
      selection,
    },
    text: {
      fg,
      fgDim: blend(fg, bg, 0.15),
      gutter: comment,
      comment,
      muted: blend(comment, fg, 0.35),
    },
    border: { idle: comment, focus: a.purple },
    diff: {
      add: tint(a.green, 0.16),
      delete: tint(a.red, 0.16),
      change: tint(a.cyan, 0.07),
      text: tint(a.orange, 0.32),
      textAdd: tint(a.green, 0.34),
      textDelete: tint(a.red, 0.34),
      deleteFiller: blend(a.red, bg, 0.5),
      addDim: tint(a.green, 0.1),
      deleteDim: tint(a.red, 0.1),
    },
    git: { add: a.green, change: a.orange, delete: a.red, ignore: comment },
    status: { error: a.red, warning: a.orange, info: a.cyan, hint: a.purple },
    accent: { ...a },
  };
}
