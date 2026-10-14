import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSuggest, upgradeNoticeFor, parseHookInput } from "../../src/commands/suggest.js";
import { recordSession, recordSwap, takeUpgradeNotice } from "../../src/hooks/session-versions.js";

const NOW = Date.UTC(2026, 9, 13);

async function harness(running = "0.40.0", hotSwap = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "pb-upgrade-notice-"));
  const prompt = (sessionId?: string, cwd = "/work/app") =>
    JSON.stringify({ prompt: "please refactor the parser", cwd, session_id: sessionId });
  const run = async (raw: string) => {
    const printed: string[] = [];
    await runSuggest(raw, {
      print: (l) => printed.push(l),
      // No token, no pickers: the notice must not depend on them.
      pick: async () => [],
      upgradeNotice: (input) => upgradeNoticeFor(input, dataDir, running, hotSwap),
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
    expect(first[0]).toContain("/mcp reconnect all");
    expect(first[0]).toContain("BRAIN_MCP_HOT_SWAP=1");
    expect(first[0]).toContain("76 MB");
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

    const [notice] = await h.run(h.prompt("s1", "/work/app"));
    expect(notice).toContain("the MCP server already swapped to it");
    expect(notice).not.toContain("/mcp reconnect");
    expect(notice).not.toContain("BRAIN_MCP_HOT_SWAP");
  });

  it("does not claim a swap made in another project", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);
    await recordSwap(h.dataDir, { cwd: "/elsewhere", from: "0.39.0", to: "0.40.0", at: NOW + 1000 });

    expect((await h.run(h.prompt("s1")))[0]).toContain("/mcp reconnect all");
  });

  it("matches the project directory exactly, not a parent or a subdirectory", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);
    await recordSwap(h.dataDir, { cwd: "/work/app", from: "0.39.0", to: "0.40.0", at: NOW + 1000 });

    expect((await h.run(h.prompt("s1", "/work/app/src")))[0]).toContain("/mcp reconnect all");
  });

  it("with the hot swap on and no swap recorded, says to reconnect only if the tools look stale", async () => {
    const h = await harness("0.40.0", true);
    await recordSession(h.dataDir, "s1", "0.39.0", NOW);

    const [notice] = await h.run(h.prompt("s1"));
    expect(notice).toContain("if project-brain tools look stale, run `/mcp reconnect all`");
    expect(notice).not.toContain("76 MB");
  });

  it("/compact and /clear reload CLAUDE.md but not the MCP server: the reconnect hint stays, the routing table does not repeat", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW, "startup");
    await recordSession(h.dataDir, "s1", "0.40.0", NOW + 1, "compact");

    const [notice] = await h.run(h.prompt("s1"));
    expect(notice).toContain("project-brain updated 0.39.0 → 0.40.0");
    expect(notice).toContain("/mcp reconnect all");
    expect(notice).not.toContain("| Task |");
  });

  it("a new process (startup, resume) starts both versions fresh, so there is nothing to announce", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "s1", "0.39.0", NOW, "startup");
    await recordSession(h.dataDir, "s1", "0.40.0", NOW + 1, "resume");

    expect(await h.run(h.prompt("s1"))).toEqual([]);
  });

  it("announces each update once: a later update is told again", async () => {
    const h1 = await harness("0.40.0");
    await recordSession(h1.dataDir, "s1", "0.39.0", NOW);
    expect((await h1.run(h1.prompt("s1"))).length).toBe(1);
    expect(await h1.run(h1.prompt("s1"))).toEqual([]);

    const later = await upgradeNoticeFor({ prompt: "x", cwd: "/work/app", sessionId: "s1" }, h1.dataDir, "0.41.0", false);
    expect(later?.text).toContain("0.39.0 → 0.41.0");
  });

  it("prunes sessions older than a week, by mtime, at most once a day", async () => {
    const h = await harness();
    await recordSession(h.dataDir, "old", "0.38.0", NOW);
    const dir = join(h.dataDir, "sessions");
    const aged = new Date(NOW - 8 * 24 * 3600_000);
    await utimes(join(dir, "old.json"), aged, aged);

    await recordSession(h.dataDir, "second", "0.39.0", NOW + 1000);
    expect((await readdir(dir)).sort()).toContain("old.json"); // pruned a moment ago already: skipped

    await rm(join(dir, ".pruned"));
    await recordSession(h.dataDir, "third", "0.39.0", NOW + 2000);
    expect((await readdir(dir)).filter((n) => n.endsWith(".json")).sort()).toEqual(["second.json", "third.json"]);
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
