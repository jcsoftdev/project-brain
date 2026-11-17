import { describe, expect, it } from "bun:test";
import { contrast, READABLE_CONTRAST, THEMES, themeById, uiRolesOf } from "../../src/themes/index.js";

const HEX = /^#[0-9a-f]{6}$/;
const dracula = themeById("dracula");

describe("UI roles", () => {
  it("gives Dracula the Tokyo Night + Dracula mix Neovim paints, value for value", () => {
    const { dim: _dim, ...roles } = uiRolesOf(dracula);
    expect(roles).toEqual({
      surface: {
        base: "#17141d",
        float: "#2e2e3c",
        line: "#2b2b38",
        selection: "#44475a",
        search: "#684d39",
        searchCurrent: "#ffb86c",
      },
      text: {
        fg: "#f8f8f2",
        fgDim: "#d6d6d2",
        gutter: "#6272a4",
        comment: "#6272a4",
        muted: "#97a1bf",
        hint: "#8f9abb",
        onAccent: "#17141d",
        path: "#bd93f9",
      },
      border: { idle: "#6272a4", focus: "#bd93f9", input: "#ffb86c" },
      picker: {
        row: "#2b2b38",
        match: "#8be9fd",
        pointer: "#ff79c6",
        marker: "#ff79c6",
        prompt: "#ffb86c",
        spinner: "#ffb86c",
        header: "#97a1bf",
        info: "#97a1bf",
      },
      diff: {
        add: "#1e3028",
        delete: "#331c24",
        change: "#1e212a",
        text: "#4a382e",
        textAdd: "#244732",
        textDelete: "#4a2229",
        deleteFiller: "#8b3539",
        addDim: "#1d2b26",
        deleteDim: "#2e1b23",
        hunk: "#8be9fd",
        file: "#bd93f9",
      },
      git: { add: "#50fa7b", change: "#ffb86c", delete: "#ff5555", ignore: "#6272a4", unstaged: "#ff5555" },
      status: { error: "#ff5555", warning: "#ffb86c", info: "#8be9fd", hint: "#bd93f9", progress: "#ffb86c" },
      syntax: {
        keyword: "#ff79c6",
        operator: "#ff79c6",
        function: "#50fa7b",
        builtin: "#8be9fd",
        type: "#8be9fd",
        string: "#f1fa8c",
        escape: "#ff79c6",
        regexp: "#ffb86c",
        number: "#bd93f9",
        constant: "#bd93f9",
        parameter: "#ffb86c",
        variable: "#f8f8f2",
        comment: "#6272a4",
        tag: "#ff79c6",
        tagDelimiter: "#6272a4",
        attribute: "#50fa7b",
        heading: "#bd93f9",
        link: "#8be9fd",
        raw: "#50fa7b",
      },
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
    const { dim: _dim, ...roles } = uiRolesOf(theme);
    for (const group of Object.values(roles)) {
      for (const [role, value] of Object.entries(group)) expect(value, role).toMatch(HEX);
    }
  });

  it("hands out a copy of the accents, so a tool cannot repaint the theme", () => {
    uiRolesOf(dracula).accent.red = "#000000";
    expect(dracula.accents.red).toBe("#ff5555");
  });

  it("fades an accent a quarter of the way to the base, and leaves red alone because faded red is unreadable", () => {
    const { dim, accent, surface } = uiRolesOf(dracula);
    expect([accent.purple, accent.pink, accent.orange, accent.green, accent.cyan].map((color) => dim(color))).toEqual([
      "#9473c2",
      "#c5609c",
      "#c58f58",
      "#42c164",
      "#6eb4c5",
    ]);
    expect(dim(accent.red)).toBe(accent.red);
    expect(dim(accent.yellow, 0.5)).toBe("#848755");
    expect(dim(accent.purple, 0.5)).toBe(accent.purple);
    for (const color of Object.values(accent)) expect(contrast(dim(color), surface.base)).toBeGreaterThanOrEqual(READABLE_CONTRAST);
  });

  it("keeps changed words louder than changed lines, and a changed row quieter than an added or deleted one", () => {
    const { diff, surface } = uiRolesOf(dracula);
    const lift = (tint: string) => contrast(tint, surface.base);
    expect(lift(diff.textAdd)).toBeGreaterThan(lift(diff.add));
    expect(lift(diff.textDelete)).toBeGreaterThan(lift(diff.delete));
    expect(lift(diff.text)).toBeGreaterThan(lift(diff.change));
    expect(lift(diff.change)).toBeLessThan(lift(diff.add));
    expect(lift(diff.change)).toBeLessThan(lift(diff.delete));
    expect(lift(diff.addDim)).toBeLessThan(lift(diff.add));
  });

  it("keeps body text, pink and purple readable on the orange and red word tints", () => {
    const { diff, text, accent } = uiRolesOf(dracula);
    for (const tint of [diff.text, diff.textDelete]) {
      for (const color of [text.fg, accent.pink, accent.purple]) expect(contrast(color, tint)).toBeGreaterThanOrEqual(READABLE_CONTRAST);
    }
    expect(contrast(text.fg, diff.textAdd)).toBeGreaterThanOrEqual(READABLE_CONTRAST);
  });

  it("keeps hint text readable on every layer text sits on, and quieter than muted text", () => {
    const { text, surface } = uiRolesOf(dracula);
    for (const layer of [surface.base, surface.line, surface.float]) {
      expect(contrast(text.hint, layer)).toBeGreaterThanOrEqual(READABLE_CONTRAST);
    }
    expect(contrast(text.hint, surface.base)).toBeLessThan(contrast(text.muted, surface.base));
  });
});

describe("contrast", () => {
  it("measures WCAG ratios and refuses what is not a hex", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#f8f8f2", "#17141d")).toBeCloseTo(17.07, 2);
    expect(contrast("claude", "#000000")).toBeNaN();
  });
});
