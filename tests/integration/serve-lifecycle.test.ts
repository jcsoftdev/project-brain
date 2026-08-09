/**
 * A stdio MCP server must not outlive its client.
 *
 * It did. `serve` handled SIGINT and SIGTERM, but a host that crashes or is
 * force-quit sends neither, and the file watcher keeps the event loop alive
 * forever. Measured on the author's machine before this fix: 19 live servers,
 * 6 of them orphaned to init, the oldest up 3 days 11 hours, each holding
 * roughly 3 GB of physical footprint and serving nobody.
 *
 * Two dead ends, both worth keeping so nobody re-walks them:
 *
 *   - Watching stdin. The SDK's stdio transport subscribes to `data` and
 *     `error` only, so it never observes EOF; and adding our own listener broke
 *     the handshake outright — the server answered nothing, 3/3, while the
 *     unmodified build answered 3/3. The transport counts stdin listeners when
 *     deciding whether to pause the stream, so it is not a stream to share.
 *   - Polling `process.ppid`. Bun caches it; it still reads the dead parent's
 *     pid long after init has adopted the process. Verified directly.
 *
 * What works is asking whether the ORIGINAL parent still exists, via signal 0.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "../../src/cli.ts");
const REPO = join(import.meta.dir, "../..");

/** Resolves to the exit code, or null if the process outlived the deadline. */
async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | null> {
  return await Promise.race([
    proc.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * cwd MUST be a real project. In an empty directory no watcher starts, nothing
 * holds the event loop, and the server exits on its own — which made an earlier
 * version of these tests pass against the buggy build. Every orphan measured in
 * the wild was serving an indexed project.
 */
function spawnServe(dataDir: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawn(["bun", CLI, "serve"], {
    cwd: REPO,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      BRAIN_DATA_DIR: dataDir,
      BRAIN_NO_UPDATE_CHECK: "1",
      ...extraEnv,
    },
  });
}

describe("serve — stdio lifecycle", () => {
  /** True while a pid exists. Signal 0 tests existence without delivering. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("exits once its parent is gone, with no signal sent to it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pb-orphan-"));

    // The shell must NOT exec: exec replaces the shell with the server, so the
    // spawned handle would BE the server and killing it would prove nothing.
    // An earlier version of this test did exactly that and passed against the
    // unfixed build. Background the server, print its pid, keep the shell alive.
    //
    // `bash`, not `sh`, and `<&0` is load-bearing. POSIX gives an asynchronous
    // command's stdin /dev/null when job control is off, so a bare `serve &`
    // reads EOF the instant it starts and the stdio transport shuts the server
    // down — the test then fails at "server died before we orphaned it",
    // never reaching the orphan check it exists to exercise. `<&0` hands the
    // shell's own stdin (our pipe) down instead, but only bash honours that
    // override; dash, which is /bin/sh on Ubuntu runners, keeps /dev/null and
    // the suite stayed red on CI while passing on macOS, where /bin/sh IS bash.
    //
    // The pipe's write end lives in THIS process, so it stays open after the
    // shell is killed and the server still has to notice the orphaning itself.
    const shell = Bun.spawn(
      ["bash", "-c", `bun ${CLI} serve <&0 & echo $! && wait`],
      {
        cwd: REPO,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: {
          ...process.env,
          BRAIN_DATA_DIR: dataDir,
          BRAIN_NO_UPDATE_CHECK: "1",
          BRAIN_ORPHAN_CHECK_MS: "500",
        },
      }
    );

    let serverPid = 0;
    try {
      const reader = shell.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      serverPid = Number(new TextDecoder().decode(value ?? new Uint8Array()).trim());
      expect(serverPid, "could not read the server pid").toBeGreaterThan(0);

      // Let it come up fully — watcher started, event loop held open.
      await new Promise((r) => setTimeout(r, 3000));
      expect(alive(serverPid), "server died before we orphaned it").toBe(true);

      // SIGKILL the parent. Nothing reaches the server; it must notice itself.
      shell.kill("SIGKILL");
      await shell.exited;

      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && alive(serverPid)) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(alive(serverPid), "server outlived the parent that spawned it").toBe(false);
    } finally {
      if (serverPid > 0 && alive(serverPid)) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      shell.kill();
      await shell.exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 40000);

  it("still exits on SIGTERM", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pb-serve-term-"));
    const proc = spawnServe(dataDir);

    try {
      await new Promise((r) => setTimeout(r, 2500));
      proc.kill("SIGTERM");
      expect(await exitWithin(proc, 8000)).not.toBeNull();
    } finally {
      proc.kill();
      await proc.exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20000);

  /**
   * The orphan check must never cost the handshake. An earlier attempt that
   * touched stdin passed a liveness test while silently answering nothing, so
   * a real initialize round-trip is the only assertion that catches it.
   */
  it("still answers a real MCP initialize over stdio", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pb-serve-hs-"));
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    });

    const proc = Bun.spawn(["bun", CLI, "serve"], {
      cwd: REPO,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_NO_UPDATE_CHECK: "1" },
    });

    try {
      proc.stdin.write(`${request}\n`);
      proc.stdin.flush();

      const reader = proc.stdout.getReader();
      const deadline = Date.now() + 15000;
      let seen = "";
      while (Date.now() < deadline && !seen.includes('"result"')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      reader.releaseLock();

      expect(seen, "no initialize response — the lifecycle hook ate the transport")
        .toContain('"result"');
      expect(seen).toContain("project-brain");
    } finally {
      proc.kill();
      await proc.exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});

/**
 * The npm install path puts a shim between the client and the server:
 * `bin/project-brain` (Node/Bun) runs the native binary with execFileSync and
 * blocks. So the server's PARENT is the shim, not the AI tool.
 *
 * That breaks a naive parent check. If the tool dies but the shim survives —
 * still blocked in execFileSync — the server sees a live parent and stays up
 * forever. The shim tells the server which pid actually matters.
 *
 * Fixing the server fixes the pair: when it exits, execFileSync returns and the
 * shim exits too.
 */
describe("serve — client pid handed down by the shim", () => {
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("watches BRAIN_CLIENT_PID instead of its immediate parent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pb-clientpid-"));

    // Stands in for the AI tool: a process the server must outlive nothing of.
    const client = Bun.spawn(["sh", "-c", "sleep 300"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // The server's real parent is bun-test, which stays alive throughout. Only
    // BRAIN_CLIENT_PID going away may end it — proving it watches that pid.
    const server = Bun.spawn(["bun", CLI, "serve"], {
      cwd: REPO,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        BRAIN_DATA_DIR: dataDir,
        BRAIN_NO_UPDATE_CHECK: "1",
        BRAIN_ORPHAN_CHECK_MS: "500",
        BRAIN_CLIENT_PID: String(client.pid),
      },
    });

    try {
      await new Promise((r) => setTimeout(r, 3000));
      expect(await exitWithin(server, 10), "server died before the client did").toBeNull();

      client.kill("SIGKILL");
      await client.exited;

      const code = await exitWithin(server, 12000);
      expect(code, "server ignored BRAIN_CLIENT_PID and watched the shim instead").not.toBeNull();
    } finally {
      client.kill();
      server.kill();
      await server.exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 40000);
});
