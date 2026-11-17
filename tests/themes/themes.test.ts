import { describe, expect, it } from "bun:test";
import { blend, lighten, THEMES, themeById } from "../../src/themes/index.js";
import { claudeCodeThemeOf, claudeCodeThemeRef } from "../../src/themes/claude-code.js";

const HEX = /^#[0-9a-f]{6}$/;

describe("theme registry", () => {
  it("holds well-formed themes with unique ids", () => {
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
    for (const theme of THEMES) {
      for (const hex of [theme.background, theme.foreground, theme.selection, theme.comment, ...Object.values(theme.accents), ...theme.ansi]) {
        expect(hex).toMatch(HEX);
      }
      expect(theme.ansi).toHaveLength(16);
    }
  });

  it("names the unknown theme and the known ones", () => {
    expect(() => themeById("nope")).toThrow(/Unknown theme "nope".*dracula/);
  });

  it("mixes colours channel by channel and leaves what is not a hex alone", () => {
    expect(blend("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blend("#50fa7b", "#17141d", 0.5)).toBe("#34874c");
    expect(blend("claude", "#ffffff", 0.5)).toBe("claude");
    expect(lighten("#000000", 1)).toBe("#ffffff");
  });
});

describe.each(THEMES.map((theme) => [theme.id, theme] as const))("Claude Code theme from %s", (_id, theme) => {
  const { overrides, name, base } = claudeCodeThemeOf(theme);

  it("is a dark-based custom theme whose reference matches its file name", () => {
    expect(base).toBe("dark");
    expect(name).toContain(theme.label);
    expect(claudeCodeThemeRef(theme)).toBe(`custom:project-brain-${theme.id}`);
  });

  it("paints every token as a hex", () => {
    for (const [token, value] of Object.entries(overrides)) expect(value, token).toMatch(HEX);
  });

  it("themes the /diff view: rows are the accent mixed into the background, words a stronger mix", () => {
    expect(overrides.diffAdded).toBe(blend(theme.background, theme.accents.green, 0.2));
    expect(overrides.diffRemoved).toBe(blend(theme.background, theme.accents.red, 0.2));
    expect(overrides.diffAddedWord).toBe(blend(theme.background, theme.accents.green, 0.38));
    expect(overrides.diffRemovedWord).toBe(blend(theme.background, theme.accents.red, 0.38));
    expect(overrides.diffAddedDimmed).not.toBe(overrides.diffAdded);
  });

  it("keeps the role colours the activity pane uses, so the two agree", () => {
    expect(overrides.success).toBe(theme.accents.green);
    expect(overrides.error).toBe(theme.accents.red);
    expect(overrides.warning).toBe(theme.accents.orange);
    expect(overrides.permission).toBe(theme.accents.purple);
    expect(overrides.suggestion).toBe(theme.accents.cyan);
    expect(overrides.claude).toBe(theme.accents.pink);
    expect(overrides.subtle).toBe(theme.comment);
    expect(overrides.text).toBe(theme.foreground);
  });
});
