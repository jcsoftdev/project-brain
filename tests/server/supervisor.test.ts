import { describe, it, expect, afterEach } from "bun:test";
import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LineFramer, launcherSignature, resolveLauncher } from "../../src/server/supervisor.js";

// The "binary" is an executable script behind a symlink, and an update retargets the link — the way
// brew moves /opt/homebrew/bin/project-brain to a new keg. The worker speaks raw JSON-RPC lines, so
// the supervisor's bookkeeping is exercised directly and deterministically.
const supervisorSrc = join(import.meta.dir, "../../src/server/supervisor.ts");

const worker = (version: string, mode: "ok" | "crash" | "hang" | "lie" = "ok") => `#!${process.execPath}
import { appendFileSync } from "node:fs";
const VERSION = ${JSON.stringify(version)};
if (process.argv[2] === "--version") { console.log(VERSION); process.exit(0); }
const log = (l) => appendFileSync(process.env.FAKE_LOG, l + "\\n");
log("boot " + VERSION + " " + process.pid);
if (${JSON.stringify(mode)} === "crash") process.exit(3);
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
// Contract of a real worker: gone when its stdin closes or its supervisor dies.
process.stdin.on("end", () => setTimeout(() => { log("stdin-end " + VERSION); process.exit(0); }, Number(process.env.FAKE_TERM_MS) || 0));
setInterval(() => { try { process.kill(Number(process.env.BRAIN_CLIENT_PID), 0); } catch { log("orphan " + VERSION); process.exit(0); } }, 100);
process.on("SIGTERM", () => setTimeout(() => { log("term " + VERSION); process.exit(0); }, Number(process.env.FAKE_TERM_MS) || 0));
if (${JSON.stringify(mode)} === "hang") { process.stdin.resume(); }
else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i !== -1; i = buf.indexOf("\\n")) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.method === "initialize") out({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: ${JSON.stringify(mode === "lie" ? "0.0.1" : version)} } } });
      else if (msg.method === "whoami") out({ id: msg.id, result: { v: VERSION, pid: process.pid } });
      else if (msg.method === "echo") out({ id: msg.id, result: { v: VERSION, text: msg.params.text } });
      else if (msg.method === "open-ask") { out({ id: "srv-2", method: "x/ask" }); out({ id: msg.id, result: { v: VERSION } }); }
      else if (msg.method === "emit-cancelled") {
        out({ id: "srv-1", method: "x/ask" });
        out({ method: "notifications/cancelled", params: { requestId: "srv-1" } });
        out({ id: msg.id, result: { v: VERSION } });
      }
    }
  });
}
`;

const dirs: string[] = [];
const procs: { kill(s?: number): void }[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) try { p.kill(9); } catch {}
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type Env = Record<string, string>;

async function boot(opts: { termMs?: number; handoverMs?: number; env?: Env } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pb-supervisor-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const logFile = join(dir, "log.txt");
  await writeFile(logFile, "");
  const install = async (version: string, mode: "ok" | "crash" | "hang" | "lie" = "ok") => {
    const file = join(dir, `project-brain-${version}-${mode}`);
    await writeFile(file, worker(version, mode));
    await chmod(file, 0o755);
    return file;
  };
  const point = async (target: string) => {
    const tmp = join(bin, ".tmp-link");
    await rm(tmp, { force: true });
    await symlink(target, tmp);
    await rename(tmp, join(bin, "project-brain"));
  };
  await point(await install("1.0.0"));

  const runner = join(dir, "run.ts");
  await writeFile(
    runner,
    `import { runSupervisor } from ${JSON.stringify(supervisorSrc)};
const link = ${JSON.stringify(join(bin, "project-brain"))};
const code = await runSupervisor({
  launcher: { argv: [link], watch: link }, args: ["serve"], version: "1.0.0",
  checkIntervalMs: 50, handoverTimeoutMs: ${opts.handoverMs ?? 5000}, graceMs: 5000, orphanCheckMs: 100,
});
process.exit(code);
`
  );
  const proc = Bun.spawn([process.execPath, runner], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", FAKE_LOG: logFile, FAKE_TERM_MS: String(opts.termMs ?? 0), ...opts.env },
  });
  procs.push(proc);

  const lines: any[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      for (let i = pending.indexOf("\n"); i !== -1; i = pending.indexOf("\n")) {
        lines.push(JSON.parse(pending.slice(0, i)));
        pending = pending.slice(i + 1);
      }
    }
  })();

  const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return true;
      await Bun.sleep(20);
    }
    return false;
  };
  let nextId = 1;
  const sendRaw = (data: string | Uint8Array) => {
    (proc.stdin as any).write(data);
    (proc.stdin as any).flush?.();
  };
  const call = async (method: string, params: unknown = {}) => {
    const id = nextId++;
    sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    expect(await until(() => lines.some((l) => l.id === id))).toBe(true);
    return lines.find((l) => l.id === id).result;
  };
  const changed = () => lines.filter((l) => l.method === "notifications/tools/list_changed").length;
  const log = async () => (await readFile(logFile, "utf8")).split("\n").filter(Boolean);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  return { dir, proc, point, install, call, sendRaw, until, changed, log, alive, lines };
}

const pidsOf = (log: string[]) => log.filter((l) => l.startsWith("boot ")).map((l) => Number(l.split(" ")[2]));

describe("MCP supervisor", () => {
  it("chained v1 -> v2 -> v3: each step answered by the newest worker, old ones retire, nothing nests", async () => {
    const h = await boot();
    expect((await h.call("whoami")).v).toBe("1.0.0");

    await h.point(await h.install("2.0.0"));
    expect(await h.until(() => h.changed() === 1)).toBe(true);
    expect((await h.call("whoami")).v).toBe("2.0.0");

    await h.point(await h.install("3.0.0"));
    expect(await h.until(() => h.changed() === 2)).toBe(true);
    expect((await h.call("whoami")).v).toBe("3.0.0");

    const pids = pidsOf(await h.log());
    expect(pids.length).toBe(3);
    expect(await h.until(() => !h.alive(pids[0]) && !h.alive(pids[1]))).toBe(true);
    expect(h.alive(pids[2])).toBe(true);

    h.proc.kill("SIGTERM");
    await h.proc.exited;
    expect(await h.until(() => pids.every((p) => !h.alive(p)))).toBe(true);
  }, 30_000);

  it("SIGKILL of the supervisor leaves no worker behind", async () => {
    const h = await boot();
    await h.point(await h.install("2.0.0"));
    expect(await h.until(() => h.changed() === 1)).toBe(true);
    const pids = pidsOf(await h.log());

    h.proc.kill("SIGKILL");
    await h.proc.exited;
    expect(await h.until(() => pids.every((p) => !h.alive(p)), 5000)).toBe(true);
  }, 30_000);

  it("closing the client's stdin shuts everything down", async () => {
    const h = await boot();
    const pids = pidsOf(await h.log());
    (h.proc.stdin as any).end();
    await h.proc.exited;
    expect(await h.until(() => pids.every((p) => !h.alive(p)))).toBe(true);
  }, 30_000);

  it("a slow drain of the old worker neither blocks the cutover nor breaks the session", async () => {
    const h = await boot({ termMs: 1500 });
    const [oldPid] = pidsOf(await h.log());
    await h.point(await h.install("2.0.0"));
    expect(await h.until(() => h.changed() === 1)).toBe(true);

    const t0 = Date.now();
    expect((await h.call("whoami")).v).toBe("2.0.0");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.alive(oldPid)).toBe(true); // still draining
    expect(await h.until(() => !h.alive(oldPid))).toBe(true);
    expect((await h.call("whoami")).v).toBe("2.0.0");
  }, 30_000);

  for (const mode of ["crash", "hang", "lie"] as const) {
    it(`a new worker that ${mode === "lie" ? "reports the wrong version" : mode === "crash" ? "crashes on boot" : "never answers"} leaves the old one serving, untouched, and is not retried`, async () => {
      const h = await boot({ handoverMs: 400 });
      const [oldPid] = pidsOf(await h.log());
      await h.point(await h.install("2.0.0", mode));
      expect(await h.until(async () => (await h.log()).some((l) => l.startsWith("boot 2.0.0")))).toBe(true);
      await Bun.sleep(900);

      expect((await h.call("whoami")).v).toBe("1.0.0");
      expect(h.changed()).toBe(0);
      expect(h.alive(oldPid)).toBe(true);
      expect((await h.log()).filter((l) => l.startsWith("boot 2.0.0")).length).toBe(1);
      if (mode !== "crash") expect(await h.until(async () => !pidsOf(await h.log()).slice(1).some((p) => h.alive(p)))).toBe(true);
    }, 30_000);
  }

  it("a server request that is cancelled by the server does not keep the session busy", async () => {
    const h = await boot();
    await h.point(await h.install("2.0.0"));
    // Worker 1 opens a request to the client and cancels it before answering.
    expect((await h.call("emit-cancelled")).v).toBe("1.0.0");
    expect(await h.until(() => h.changed() === 1)).toBe(true);
    expect((await h.call("whoami")).v).toBe("2.0.0");
  }, 30_000);

  it("waits for a server request the client has not answered, then swaps once it does", async () => {
    const h = await boot();
    await h.point(await h.install("2.0.0"));
    expect((await h.call("open-ask")).v).toBe("1.0.0");
    await Bun.sleep(600); // the new worker is ready, but the old one still has a question out
    expect(h.changed()).toBe(0);
    h.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: "srv-2", result: {} }) + "\n");
    expect(await h.until(() => h.changed() === 1)).toBe(true);
  }, 30_000);

  it("never cuts over inside a half-sent line, and keeps multi-byte characters intact across chunks", async () => {
    const h = await boot();
    await h.point(await h.install("2.0.0"));

    const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 900, method: "echo", params: { text: "café \u{1F600}" } }) + "\n");
    // Split inside the two-byte "é" and again inside the four-byte emoji.
    const e = bytes.indexOf(0xc3) + 1;
    const g = bytes.indexOf(0xf0) + 2;
    h.sendRaw(bytes.subarray(0, e));
    await Bun.sleep(400); // the new worker is ready by now but the line is half-sent
    expect(h.changed()).toBe(0);
    h.sendRaw(bytes.subarray(e, g));
    await Bun.sleep(100);
    h.sendRaw(bytes.subarray(g));

    expect(await h.until(() => h.lines.some((l) => l.id === 900))).toBe(true);
    const reply = h.lines.find((l) => l.id === 900).result;
    expect(reply).toEqual({ v: "1.0.0", text: "café \u{1F600}" });
    expect(await h.until(() => h.changed() === 1)).toBe(true);
    expect((await h.call("whoami")).v).toBe("2.0.0");
  }, 30_000);
});

describe("launcher detection", () => {
  it("a retargeted symlink changes the signature; an untouched one does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-launcher-"));
    dirs.push(dir);
    await writeFile(join(dir, "a"), "aaa");
    await writeFile(join(dir, "b"), "bbbb");
    const link = join(dir, "link");
    await symlink(join(dir, "a"), link);

    const before = launcherSignature(link);
    expect(launcherSignature(link)).toBe(before);
    await rm(link);
    await symlink(join(dir, "b"), link);
    expect(launcherSignature(link)).not.toBe(before);
    expect(launcherSignature(join(dir, "missing"))).toBeNull();
  });

  it("a compiled binary behind a PATH symlink is launched by the link, not by the keg it resolved to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-launcher-"));
    dirs.push(dir);
    await writeFile(join(dir, "keg-1"), "x");
    const link = join(dir, "project-brain");
    await symlink(join(dir, "keg-1"), link);
    const keg = await Bun.file(join(dir, "keg-1")).exists().then(() => join(dir, "keg-1"));
    const real = (await import("node:fs")).realpathSync(keg);

    const launcher = resolveLauncher(real, ["/bun", "/$bunfs/root/project-brain"], "project-brain", (n) => (n === "project-brain" ? link : null));
    expect(launcher).toEqual({ argv: [link], watch: link });

    // An unrelated project-brain on PATH is not adopted.
    await writeFile(join(dir, "other"), "y");
    const other = join(dir, "other-link");
    await symlink(join(dir, "other"), other);
    expect(resolveLauncher(real, ["/bun", "/$bunfs/root/project-brain"], "project-brain", () => other)).toEqual({ argv: [real], watch: real });
  });

  it("running from source under bun launches bun + the script", () => {
    expect(resolveLauncher("/usr/bin/bun", ["bun", "/repo/src/cli.ts"], "bun", () => null)).toEqual({
      argv: ["/usr/bin/bun", "/repo/src/cli.ts"],
      watch: "/repo/src/cli.ts",
    });
  });
});

describe("LineFramer", () => {
  it("reassembles lines split across chunks on byte offsets", () => {
    const f = new LineFramer();
    const got: string[] = [];
    const bytes = Buffer.from("{\"a\":\"é\"}\n{\"b\":1}\n");
    const cut = bytes.indexOf(0xc3) + 1;
    f.push(bytes.subarray(0, cut), (l) => got.push(l.toString()));
    expect(f.clean).toBe(false);
    f.push(bytes.subarray(cut, bytes.length - 3), (l) => got.push(l.toString()));
    f.push(bytes.subarray(bytes.length - 3), (l) => got.push(l.toString()));
    expect(got).toEqual(['{"a":"é"}', '{"b":1}']);
    expect(f.clean).toBe(true);
  });
});
