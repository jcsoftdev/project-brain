import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";
import { mergeServerEntry } from "../../src/registrars/json-config.js";

describe("re-registering keeps what the user added", () => {
  it("mergeServerEntry updates command/args/transport and keeps env and unknown keys", () => {
    const merged = mergeServerEntry({ command: "old", args: ["x"], env: { A: "1" }, extra: 2 }, "/bin/project-brain");
    expect(merged).toEqual({ command: "/bin/project-brain", args: [], transport: "stdio", env: { A: "1" }, extra: 2 });
    expect(mergeServerEntry(undefined, "/bin/project-brain")).toEqual({ command: "/bin/project-brain", args: [], transport: "stdio" });
    expect(mergeServerEntry("junk", "/bin/project-brain")).toEqual({ command: "/bin/project-brain", args: [], transport: "stdio" });
  });

  it("the Claude JSON fallback keeps env (e.g. BRAIN_MCP_HOT_SWAP=1)", async () => {
    const home = await mkdtemp(join(tmpdir(), "pb-merge-"));
    await mkdir(join(home, ".claude"));
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { "project-brain": { command: "/old", args: [], env: { BRAIN_MCP_HOT_SWAP: "1" } } } })
    );
    await new ClaudeRegistrar(join(home, ".claude"), async () => false, home).register("/opt/homebrew/bin/project-brain");

    const entry = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")).mcpServers["project-brain"];
    expect(entry.command).toBe("/opt/homebrew/bin/project-brain");
    expect(entry.env).toEqual({ BRAIN_MCP_HOT_SWAP: "1" });
  });
});
