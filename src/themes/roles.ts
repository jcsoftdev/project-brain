import { blend, contrast } from "./color.js";
import type { ThemeDefinition } from "./types.js";

/** WCAG's floor for normal-size text; a dimmed accent that would fall below it on the base stays undimmed. */
export const READABLE_CONTRAST = 4.5;

/**
 * The "Tokyo Night + Dracula" mix: tokyonight's structure (layered surfaces, borders, a diff palette) painted with the
 * theme's colours. Every value Neovim also paints matches what `templates/nvim/lua/project-brain/highlights.lua`
 * computes, and a headless Neovim test holds the two together. All colours are `#rrggbb`.
 */
export interface UiRoles {
  /** Background layers, darkest first; `search`/`searchCurrent` are a search hit and the hit under the cursor. */
  surface: {
    base: string;
    float: string;
    line: string;
    selection: string;
    search: string;
    searchCurrent: string;
  };
  /** Foregrounds: `hint` is the quietest text still meant to be read; `comment` is for code comments and glyphs only. */
  text: {
    fg: string;
    fgDim: string;
    gutter: string;
    comment: string;
    muted: string;
    hint: string;
    onAccent: string;
    path: string;
  };
  /** Frame lines: idle, the focused one, and the frame of a filter or search input. */
  border: {
    idle: string;
    focus: string;
    input: string;
  };
  /** A list you filter and move through (fzf, lazygit): the current row sits on the line layer, never on selection. */
  picker: {
    row: string;
    match: string;
    pointer: string;
    marker: string;
    prompt: string;
    spinner: string;
    header: string;
    info: string;
  };
  /** Diff row backgrounds (`add`/`delete`/`change`), changed-word backgrounds (`text*`) and header foregrounds. */
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
    hunk: string;
    file: string;
  };
  /** Line-level change markers and counts, plus file-level dirtiness (`unstaged`). */
  git: {
    add: string;
    change: string;
    delete: string;
    ignore: string;
    unstaged: string;
  };
  /** Diagnostics and states; `progress` is spinners, running work and durations. */
  status: {
    error: string;
    warning: string;
    info: string;
    hint: string;
    progress: string;
  };
  /** How code is painted; Neovim draws `comment`, `parameter` and `builtin` in italic. */
  syntax: {
    keyword: string;
    operator: string;
    function: string;
    builtin: string;
    type: string;
    string: string;
    escape: string;
    regexp: string;
    number: string;
    constant: string;
    parameter: string;
    variable: string;
    comment: string;
    tag: string;
    tagDelimiter: string;
    attribute: string;
    heading: string;
    link: string;
    raw: string;
  };
  accent: ThemeDefinition["accents"];
  /** A quieter `color` for a faded state; returns `color` itself when the faded one would be unreadable on the base. */
  dim: (color: string, share?: number) => string;
}

const LINE_TINT = 0.12;
const WORD_TINT = 0.22;
const CHANGE_TINT = 0.06;

export function uiRolesOf(theme: ThemeDefinition): UiRoles {
  const { background: bg, foreground: fg, selection, comment, accents: a } = theme;
  const tint = (accent: string, share: number) => blend(bg, accent, share);
  const muted = blend(comment, fg, 0.35);
  return {
    surface: {
      base: bg,
      float: tint(selection, 0.5),
      line: tint(selection, 0.45),
      selection,
      search: tint(a.orange, 0.35),
      searchCurrent: a.orange,
    },
    text: {
      fg,
      fgDim: blend(fg, bg, 0.15),
      gutter: comment,
      comment,
      muted,
      hint: blend(comment, fg, 0.3),
      onAccent: bg,
      path: a.purple,
    },
    border: { idle: comment, focus: a.purple, input: a.orange },
    picker: {
      row: tint(selection, 0.45),
      match: a.cyan,
      pointer: a.pink,
      marker: a.pink,
      prompt: a.orange,
      spinner: a.orange,
      header: muted,
      info: muted,
    },
    diff: {
      add: tint(a.green, LINE_TINT),
      delete: tint(a.red, LINE_TINT),
      change: tint(a.cyan, CHANGE_TINT),
      text: tint(a.orange, WORD_TINT),
      textAdd: tint(a.green, WORD_TINT),
      textDelete: tint(a.red, WORD_TINT),
      deleteFiller: blend(a.red, bg, 0.5),
      addDim: tint(a.green, 0.1),
      deleteDim: tint(a.red, 0.1),
      hunk: a.cyan,
      file: a.purple,
    },
    git: { add: a.green, change: a.orange, delete: a.red, ignore: comment, unstaged: a.red },
    status: { error: a.red, warning: a.orange, info: a.cyan, hint: a.purple, progress: a.orange },
    syntax: {
      keyword: a.pink,
      operator: a.pink,
      function: a.green,
      builtin: a.cyan,
      type: a.cyan,
      string: a.yellow,
      escape: a.pink,
      regexp: a.orange,
      number: a.purple,
      constant: a.purple,
      parameter: a.orange,
      variable: fg,
      comment,
      tag: a.pink,
      tagDelimiter: comment,
      attribute: a.green,
      heading: a.purple,
      link: a.cyan,
      raw: a.green,
    },
    accent: { ...a },
    dim: (color, share = 0.25) => {
      const faded = blend(color, bg, share);
      return contrast(faded, bg) >= READABLE_CONTRAST ? faded : color;
    },
  };
}
