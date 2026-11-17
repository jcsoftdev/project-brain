import { beforeAll, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

interface PaneModule {
  modelLabel(id: string): string;
  accountOf(config: string, baseUrl: string): string;
  folderOf(root: string, home: string): string;
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
