import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, utimes, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// A tiny stand-in for the real server. Its "binary" is the script file itself, so replacing the
// file with another VERSION is exactly what `project-brain update` does to the real one.
const mcp = Bun.resolveSync("@modelcontextprotocol/sdk/server/mcp.js", import.meta.dir);
const hotSwap = join(import.meta.dir, "../../src/server/hot-swap.ts");

const script = (version: string, mode: "ok" | "crash" | "hang" = "ok") => `
import { McpServer } from ${JSON.stringify(mcp)};
import { HotSwapTransport, resolveSelfLaunch } from ${JSON.stringify(hotSwap)};
import { appendFileSync } from "node:fs";
const VERSION = ${JSON.stringify(version)};
if (process.argv[2] === "--version") { console.log(VERSION); process.exit(0); }
const log = (line) => appendFileSync(process.env.FAKE_LOG, line + "\\n");
if (process.env.BRAIN_HOT_SWAP_FROM) log("boot " + VERSION + " from " + process.env.BRAIN_HOT_SWAP_FROM);
else log("boot " + VERSION);
if (${JSON.stringify(mode)} === "crash") process.exit(3);
if (${JSON.stringify(mode)} === "hang") setInterval(() => {}, 1000);
else {
  const server = new McpServer({ name: "fake", version: VERSION });
  server.tool("whoami", async () => ({ content: [{ type: "text", text: VERSION }] }));
  server.tool("echo", { n: (await import(${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))})).z.number() }, async ({ n }) => {
    log("call " + n + " " + VERSION);
    return { content: [{ type: "text", text: VERSION + ":" + n }] };
  });
  if (VERSION.startsWith("2")) server.tool("extra", async () => ({ content: [{ type: "text", text: "extra" }] }));
  await server.connect(new HotSwapTransport({
    ...resolveSelfLaunch(),
    version: VERSION,
    checkIntervalMs: 50,
    handoverTimeoutMs: Number(process.env.FAKE_HANDOVER_MS) || 5000,
  }));
}
`;

const dirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot(extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pb-hotswap-"));
  dirs.push(dir);
  const file = join(dir, "server.ts");
  const logFile = join(dir, "log.txt");
  await writeFile(file, script("1.0.0"));
  await writeFile(logFile, "");
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void listChanged++);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [file],
      env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, ...extraEnv },
      stderr: "ignore",
    })
  );
  const replace = async (source: string) => {
    await writeFile(file, source);
    const t = new Date(Date.now() + 5000);
    await utimes(file, t, t);
  };
  const text = async (name: string, args?: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;
  const log = async () => (await readFile(logFile, "utf8")).split("\n").filter(Boolean);
  const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await Bun.sleep(25);
    }
    return false;
  };
  return { client, replace, text, log, until, changed: () => listChanged };
}

describe("MCP server hot swap", () => {
  it("hands the session to the new binary: v1 before, v2 after, list_changed sent, nothing lost or doubled", async () => {
    const h = await boot();
    expect((await h.client.listTools()).tools.map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
    expect(await h.text("whoami")).toBe("1.0.0");

    await h.replace(script("2.0.0"));

    // Keep traffic flowing through the swap: every call must be answered exactly once.
    const answers: string[] = [];
    let n = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(h.changed() > 0 && answers.some((a) => a.startsWith("2.0.0")))) {
      answers.push(await h.text("echo", { n: n++ }));
    }
    expect(h.changed()).toBeGreaterThan(0);
    expect(answers.at(-1)!.startsWith("2.0.0")).toBe(true);
    // Strictly in order, each n once, and the version only ever moves 1 -> 2.
    expect(answers.map((a) => Number(a.split(":")[1]))).toEqual(Array.from({ length: n }, (_, i) => i));
    const versions = answers.map((a) => a.split(":")[0]);
    expect(versions).toEqual([...versions].sort());

    expect(await h.text("whoami")).toBe("2.0.0");
    expect((await h.client.listTools()).tools.map((t) => t.name)).toContain("extra");

    const calls = (await h.log()).filter((l) => l.startsWith("call "));
    expect(calls.length).toBe(n);
    expect(new Set(calls.map((l) => l.split(" ")[1])).size).toBe(n);
    expect(await h.log()).toContain("boot 2.0.0 from 1.0.0");
  }, 30_000);

  it("concurrent calls during the swap are all answered exactly once", async () => {
    const h = await boot();
    await h.text("whoami");
    await h.replace(script("2.0.0"));
    const results = await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        await Bun.sleep(i * 10);
        return h.text("echo", { n: i });
      })
    );
    expect(results.map((r) => Number(r.split(":")[1]))).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(new Set(results.map((r) => r.split(":")[0]))).toEqual(new Set(["1.0.0", "2.0.0"]));
    const calls = (await h.log()).filter((l) => l.startsWith("call "));
    expect(calls.length).toBe(200);
  }, 30_000);

  it("a new server that crashes on boot leaves v1 serving, and is not retried", async () => {
    const h = await boot();
    await h.replace(script("2.0.0", "crash"));
    expect(await h.until(async () => (await h.log()).includes("boot 2.0.0 from 1.0.0"))).toBe(true);
    await Bun.sleep(600); // many check intervals later
    expect(await h.text("whoami")).toBe("1.0.0");
    expect(h.changed()).toBe(0);
    expect((await h.log()).filter((l) => l.startsWith("boot 2.0.0")).length).toBe(1);
  }, 30_000);

  it("a new server that never answers initialize times out and v1 keeps serving", async () => {
    const h = await boot({ FAKE_HANDOVER_MS: "400" });
    await h.replace(script("2.0.0", "hang"));
    expect(await h.until(async () => (await h.log()).includes("boot 2.0.0 from 1.0.0"))).toBe(true);
    await Bun.sleep(900);
    expect(await h.text("whoami")).toBe("1.0.0");
    expect(h.changed()).toBe(0);
    expect((await h.log()).filter((l) => l.startsWith("boot 2.0.0")).length).toBe(1);
  }, 30_000);

  it("does nothing when the file changes but the version does not go up", async () => {
    const h = await boot();
    await h.replace(script("1.0.0"));
    await Bun.sleep(500);
    expect(h.changed()).toBe(0);
    expect(await h.text("whoami")).toBe("1.0.0");
    expect(existsSync(join(tmpdir()))).toBe(true);
  }, 30_000);
});
