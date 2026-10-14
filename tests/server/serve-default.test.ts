import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = join(import.meta.dir, "../../src/cli.ts");

async function childrenOfServer(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "pb-serve-default-"));
  const client = new Client({ name: "t", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", cli, "serve"],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, BRAIN_NO_UPDATE_CHECK: "1", BRAIN_NO_SKILL_REFRESH: "1", BRAIN_NO_CONFIG_REPAIR: "1", ...env },
    stderr: "ignore",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    return execSync(`pgrep -P ${transport.pid} || true`).toString().trim().split("\n").filter(Boolean).length;
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("stdio serve process model", () => {
  it("runs the server in-process by default: no supervisor, no worker child", async () => {
    expect(await childrenOfServer({})).toBe(0);
  }, 30_000);

  it("BRAIN_MCP_HOT_SWAP=1 puts a supervisor in front of one worker", async () => {
    expect(await childrenOfServer({ BRAIN_MCP_HOT_SWAP: "1" })).toBe(1);
  }, 30_000);
});
