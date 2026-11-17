import type { ThemeDefinition } from "./types.js";

/** The palette module the Neovim highlights read: the one file that changes from theme to theme. */
export function neovimPaletteLua(theme: ThemeDefinition): string {
  const q = (hex: string) => `"${hex}"`;
  const accents = Object.entries(theme.accents)
    .map(([name, hex]) => `    ${name} = ${q(hex)},`)
    .join("\n");
  return [
    "return {",
    `  id = "${theme.id}",`,
    `  background = ${q(theme.background)},`,
    `  foreground = ${q(theme.foreground)},`,
    `  selection = ${q(theme.selection)},`,
    `  comment = ${q(theme.comment)},`,
    "  accents = {",
    accents,
    "  },",
    `  ansi = { ${theme.ansi.map(q).join(", ")} },`,
    "}",
    "",
  ].join("\n");
}
