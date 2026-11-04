import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { browserRouteNotice, claimSession, BROWSER_ROUTE_NOTICE } from "../../src/hooks/browser-route.js";
import {
  removeBrowserRouteHook,
  upsertArchGuardHooks,
  upsertBrowserRouteHook,
} from "../../src/hooks/claude-settings.js";

describe("browserRouteNotice", () => {
  it("speaks for chrome-devtools tools only", () => {
    expect(browserRouteNotice({ tool_name: "mcp__chrome-devtools__new_page" })).toBe(BROWSER_ROUTE_NOTICE);
    expect(browserRouteNotice({ tool_name: "mcp__playwright__browser_click" })).toBeNull();
    expect(browserRouteNotice({ tool_name: "Bash" })).toBeNull();
  });

  it("names the three routes the agent must pick between", () => {
    expect(BROWSER_ROUTE_NOTICE).toContain("headless");
    expect(BROWSER_ROUTE_NOTICE).toContain("isolatedContext");
    expect(BROWSER_ROUTE_NOTICE).toContain("explicitly asks");
  });

  it("is silent on payloads it cannot read", () => {
    expect(browserRouteNotice(null)).toBeNull();
    expect(browserRouteNotice("nonsense")).toBeNull();
    expect(browserRouteNotice({ tool_name: 7 })).toBeNull();
  });
});

describe("claimSession", () => {
  it("is true once per session and false after, independently per session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-browser-route-"));
    expect(await claimSession(dir, "s1")).toBe(true);
    expect(await claimSession(dir, "s1")).toBe(false);
    expect(await claimSession(dir, "s2")).toBe(true);
  });

  it("shows the notice again rather than losing it when the state cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-browser-route-"));
    const blocker = join(dir, "file");
    await Bun.write(blocker, "x");
    expect(await claimSession(join(blocker, "nested"), "s1")).toBe(true);
  });
});

describe("browser-route hook settings", () => {
  const preToolUse = (s: any) => s.hooks?.PreToolUse ?? [];

  it("installs one PreToolUse group matched on the chrome-devtools tools, idempotently", () => {
    const once = upsertBrowserRouteHook(null);
    const [group] = preToolUse(once);
    expect(group.matcher).toBe("mcp__chrome-devtools__.*");
    expect(group.hooks[0]).toMatchObject({ command: "project-brain browser-route", timeout: 5 });
    expect(upsertBrowserRouteHook(once)).toEqual(once);
  });

  it("removal takes only its own group", () => {
    const both = upsertBrowserRouteHook(upsertArchGuardHooks(null));
    const left = preToolUse(removeBrowserRouteHook(both)).map((g: any) => g.hooks[0].command);
    expect(left).toEqual(["project-brain arch-guard"]);
    expect((removeBrowserRouteHook(upsertBrowserRouteHook(null)) as any).hooks.PreToolUse).toBeUndefined();
  });
});
