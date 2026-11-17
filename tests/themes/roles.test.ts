import { describe, expect, it } from "bun:test";
import { THEMES, themeById, uiRolesOf } from "../../src/themes/index.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("UI roles", () => {
  it("gives Dracula the Tokyo Night + Dracula mix Neovim paints, value for value", () => {
    expect(uiRolesOf(themeById("dracula"))).toEqual({
      surface: { base: "#17141d", float: "#2e2e3c", line: "#2b2b38", selection: "#44475a" },
      text: { fg: "#f8f8f2", fgDim: "#d6d6d2", gutter: "#6272a4", comment: "#6272a4", muted: "#97a1bf" },
      border: { idle: "#6272a4", focus: "#bd93f9" },
      diff: {
        add: "#20392c",
        delete: "#3c1e26",
        change: "#1f232d",
        text: "#614836",
        textAdd: "#2a623d",
        textDelete: "#662a30",
        deleteFiller: "#8b3539",
        addDim: "#1d2b26",
        deleteDim: "#2e1b23",
      },
      git: { add: "#50fa7b", change: "#ffb86c", delete: "#ff5555", ignore: "#6272a4" },
      status: { error: "#ff5555", warning: "#ffb86c", info: "#8be9fd", hint: "#bd93f9" },
      accent: {
        red: "#ff5555",
        orange: "#ffb86c",
        yellow: "#f1fa8c",
        green: "#50fa7b",
        cyan: "#8be9fd",
        purple: "#bd93f9",
        pink: "#ff79c6",
      },
    });
  });

  it.each(THEMES.map((theme) => [theme.id, theme] as const))("paints every %s role as a hex", (_id, theme) => {
    for (const group of Object.values(uiRolesOf(theme))) {
      for (const [role, value] of Object.entries(group)) expect(value, role).toMatch(HEX);
    }
  });

  it("hands out a copy of the accents, so a tool cannot repaint the theme", () => {
    const theme = themeById("dracula");
    uiRolesOf(theme).accent.red = "#000000";
    expect(theme.accents.red).toBe("#ff5555");
  });
});
