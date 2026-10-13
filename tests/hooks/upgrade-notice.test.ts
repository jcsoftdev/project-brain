import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSuggest, upgradeNoticeFor, parseHookInput } from "../../src/commands/suggest.js";
import { recordSession, recordSwap, takeUpgradeNotice } from "../../src/hooks/session-versions.js";

const NOW = Date.UTC(2026, 9, 13);

async function harness(running = "0.40.0") {
  const dataDir = await mkdtemp(join(tmpdir(), "pb-upgrade-notice-"));
  const prompt = (sessionId?: string, cwd = "/work/app") =>
    JSON.stringify({ prompt: "please refactor the parser", cwd, session_id: sessionId });
  const run = async (raw: string) => {
    const printed: string[] = [];
    await runSuggest(raw, {
      print: (l) => printed.push(l),
      // No token, no pickers: the notice must not depend on them.
      pick: async () => [],
      upgradeNotice: (input) => upgradeNoticeFor(input, dataDir, running),
    });
    return printed;
  };
  return { dataDir, prompt, run };
}

describe("one-time update notice", () => {
  it("prints once for a session that started on an older version, then never again", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);

    const first = await h.run(h.prompt("s1"));
    expect(first.length).toBe(1);
    expect(first[0]).toContain("project-brain updated 0.39.0 → 0.40.0 in this session");
    expect(first[0]).toContain("hooks and skills are already live");
    expect(first[0]).toContain("/mcp reconnect");
    // CLAUDE.md does not reload, so the routing table is repeated in full.
    expect(first[0]).toContain("Model routing for delegated agents");
    expect(first[0]).toContain("| Task |");

    expect(await h.run(h.prompt("s1"))).toEqual([]);
  });

  it("prints nothing for an unknown session, a current session, or no session id", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "current", "0.40.0", NOW);

    expect(await h.run(h.prompt("never-seen"))).toEqual([]);
    expect(await h.run(h.prompt("current"))).toEqual([]);
    expect(await h.run(h.prompt(undefined))).toEqual([]);
  });

  it("says the server already swapped when one in this project did, after the session began", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);
    await recordSwap(h.dataDir, { cwd: "/work/app", from: "0.39.0", to: "0.40.0", at: NOW + 1000 });

    const [notice] = await h.run(h.prompt("s1", "/work/app/src"));
    expect(notice).toContain("the MCP server already swapped to it");
    expect(notice).not.toContain("/mcp reconnect");
  });

  it("does not claim a swap made in another project", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);
    await recordSwap(h.dataDir, { cwd: "/elsewhere", from: "0.39.0", to: "0.40.0", at: NOW + 1000 });

    expect((await h.run(h.prompt("s1")))[0]).toContain("/mcp reconnect");
  });

  it("a repeated SessionStart (compact, resume) resets the session to the version that reloaded CLAUDE.md", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);
    await recordSession(h.dataDir, "s1", "0.40.0", NOW + 1);

    expect(await h.run(h.prompt("s1"))).toEqual([]);
  });

  it("prunes sessions older than a week when recording", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "old", "0.38.0", NOW - 8 * 24 * 3600_000);
    await recordSession(h.dataDir, "new", "0.39.0", NOW);

    expect(await readdir(join(h.dataDir, "sessions"))).toEqual(["new.json"]);
  });

  it("marking one session notified cannot undo a session recorded in between", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "a", "0.39.0", NOW);
    const taken = await takeUpgradeNotice(h.dataDir, "a", "0.40.0");
    await recordSession(h.dataDir, "b", "0.39.0", NOW + 1); // another session starts before a is marked
    await taken!.commit();

    expect(await takeUpgradeNotice(h.dataDir, "a", "0.40.0")).toBeNull();
    expect((await takeUpgradeNotice(h.dataDir, "b", "0.40.0"))?.from).toBe("0.39.0");
  });

  it("reads session_id from the hook JSON", () => {
    expect(parseHookInput('{"prompt":"x","session_id":"abc"}').sessionId).toBe("abc");
    expect(parseHookInput("not json").sessionId).toBeUndefined();
  });
});
