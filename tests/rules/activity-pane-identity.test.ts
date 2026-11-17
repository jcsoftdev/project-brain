import { beforeAll, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

interface PaneModule {
  modelLabel(id: string): string;
  accountOf(config: string, baseUrl: string): string;
  folderOf(root: string, home: string): string;
  seconds(ms: number | undefined): string;
  paint(one: { color?: string; dim?: boolean; bold?: boolean; inverse?: boolean }): { color: string; backgroundColor?: string };
  PANE_ARGS: { backgroundColor?: string };
  blend(hex: string, into: string, share: number): string;
  againstCompaction(usage: { tokens?: number; window: number; percent?: number }, compactionWindow: number): { tokens?: number; window: number; percent?: number };
}

const MOD_PATH = join(import.meta.dir, "../../templates/claude-tui/activity-pane/hooks/register.tsx");

let pane: PaneModule;
beforeAll(async () => {
  mock.module("claude-code", () => ({ atom: (_ref: unknown, initial: unknown) => ({ initial }), read: async () => undefined, update: async () => undefined }));
  mock.module("react/jsx-dev-runtime", () => ({ jsxDEV: () => null, Fragment: "fragment" }));
  pane = (await import(MOD_PATH)) as PaneModule;
});

describe("activity pane model labels", () => {
  it.each([
    ["claude-opus-5-5", "opus 5.5"],
    ["claude-opus-5-5[1m]", "opus 5.5"],
    ["claude-haiku-5-5", "haiku 5.5"],
    ["claude-fable-5-2", "fable 5.2"],
    ["claude-sonnet-4-5-20250929", "sonnet 4.5"],
    ["haiku", "haiku"],
    ["qwen3.5:4b", "qwen3.5:4b"],
    ["", ""],
  ])("%p reads as %p", (id, label) => {
    expect(pane.modelLabel(id)).toBe(label);
  });
});

describe("activity pane account line", () => {
  const signedIn = JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com" } });

  it("names the signed-in account by its email", () => {
    expect(pane.accountOf(signedIn, "https://gateway.example.com")).toBe("dev@example.com");
  });

  it("falls back to the API gateway host without a sign-in", () => {
    expect(pane.accountOf(JSON.stringify({}), "https://gateway.example.com:8443/v1")).toBe("API · gateway.example.com:8443");
  });

  it("shows nothing when there is neither a sign-in nor a gateway", () => {
    expect(pane.accountOf("", "")).toBe("");
    expect(pane.accountOf("{not json", "")).toBe("");
  });

  it("still names the API when the base URL does not parse", () => {
    expect(pane.accountOf("", "not a url")).toBe("API");
  });

  it("shortens folders under HOME", () => {
    expect(pane.folderOf("/Users/dev/code/app", "/Users/dev")).toBe("~/code/app");
    expect(pane.folderOf("/Users/devx/app", "/Users/dev")).toBe("/Users/devx/app");
    expect(pane.folderOf("/srv/app", "")).toBe("/srv/app");
  });
});

describe("activity pane durations", () => {
  it.each([
    [undefined, ""],
    [4_200, "4.2 s"],
    [59_940, "59.9 s"],
    [185_000, "3 min 05 s"],
    [8_507_000, "2 h 22 min"],
    [95_658_200, "26 h 34 min"],
  ])("%p ms reads as %p", (ms, label) => {
    expect(pane.seconds(ms as number | undefined)).toBe(label);
  });
});

describe("activity pane context against the compaction window", () => {
  it("measures the main loop against the window that triggers compaction", () => {
    expect(pane.againstCompaction({ tokens: 282_000, window: 1_000_000, percent: 28 }, 400_000)).toEqual({ tokens: 282_000, window: 400_000 });
  });

  it("keeps the live figures when no smaller compaction window was measured", () => {
    const live = { tokens: 120_000, window: 200_000, percent: 60 };
    expect(pane.againstCompaction(live, 0)).toBe(live);
    expect(pane.againstCompaction(live, 200_000)).toBe(live);
    expect(pane.againstCompaction({ window: 1_000_000 }, 400_000)).toEqual({ window: 1_000_000 });
  });
});

describe("activity pane palette (Dracula)", () => {
  it("opens the pane transparent, or the engine fills it with its sidebar grey and hides the terminal's opacity and blur", () => {
    expect(pane.PANE_ARGS.backgroundColor).toBe("transparent");
  });

  it("leaves the background to the terminal so its opacity and blur show through", () => {
    expect(pane.paint({ color: "success" })).not.toHaveProperty("backgroundColor");
  });

  it("paints an uncoloured span as the foreground, a bold one pink and a dim one the comment grey", () => {
    expect(pane.paint({}).color).toBe("#f8f8f2");
    expect(pane.paint({ bold: true }).color).toBe("#ff79c6");
    expect(pane.paint({ dim: true }).color).toBe("#6272a4");
  });

  it("fades a dim coloured span into the pane instead of leaving the dimming to the terminal", () => {
    expect(pane.paint({ color: "success", dim: true })).toEqual({ color: pane.blend("#50fa7b", "#17141d", 0.5) });
    expect(pane.blend("#50fa7b", "#17141d", 0.5)).toBe("#34874c");
  });

  it("draws an inverse span as a pill: its colour as the fill, the pane background as the text", () => {
    expect(pane.paint({ color: "claude", inverse: true })).toEqual({ color: "#17141d", backgroundColor: "#ff79c6" });
  });
});
