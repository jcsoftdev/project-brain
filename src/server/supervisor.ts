// Thin supervisor for the stdio MCP server, so a running session can move to a newer binary
// after `project-brain update` without `/mcp reconnect`.
//
// `serve` over stdio starts this process, which spawns the real server as a worker (`serve
// --worker`) and relays raw bytes between the client and it. Nothing heavy is imported here —
// no store, no embeddings, no SDK server — so the per-session cost of the indirection stays small
// and a swap can never leave a half-released server behind: the old worker keeps serving,
// untouched, until the new one has answered `initialize` and the session is idle. Only then does
// the relay switch, and only after the switch is the old worker told to stop (SIGTERM, with a
// grace period, so it drains its watcher normally and the new worker's election takes over).
//
// The supervisor never swaps itself and a worker never swaps: no nesting, one worker active.
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isNewer } from "../notifier.js";

export interface Launcher {
  /** argv that runs the CLI with no arguments; `--version` and the worker args are appended. */
  argv: string[];
  /** The stable path whose target changes when an update lands. Not realpath'd: brew retargets the link. */
  watch: string;
}

/**
 * How to start another copy of this CLI that follows updates. A compiled binary run through a PATH
 * symlink reports the keg it resolved to as `process.execPath`, and an upgrade writes a NEW keg, so
 * the launcher has to be the name it was started by, not that realpath.
 */
export function resolveLauncher(
  execPath: string = process.execPath,
  argv: string[] = process.argv,
  argv0: string = process.argv0,
  which: (name: string) => string | null = Bun.which
): Launcher {
  const script = argv[1];
  if (/^bun(\.exe)?$/.test(basename(execPath)) && script && !script.startsWith("/$bunfs")) {
    return { argv: [execPath, script], watch: script };
  }
  const candidates = [
    argv0.includes("/") ? argv0 : which(argv0),
    which("project-brain"),
  ].filter((p): p is string => !!p && isAbsolute(p));
  for (const candidate of candidates) {
    try {
      // Only a launcher that is really this program counts; an unrelated `project-brain` on PATH does not.
      if (realpathSync(candidate) === realpathSync(execPath)) return { argv: [candidate], watch: candidate };
    } catch {
      /* try the next */
    }
  }
  return { argv: [execPath], watch: execPath };
}

/** realpath + mtime + size: a retargeted link and an overwritten file both change it. */
export function launcherSignature(watch: string): string | null {
  try {
    const real = realpathSync(watch);
    const s = statSync(real);
    return `${real}:${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** Splits a byte stream into lines for tracking only; the bytes themselves are relayed untouched. */
export class LineFramer {
  private parts: Buffer[] = [];
  private len = 0;

  /** True when no partial line is buffered. */
  get clean(): boolean {
    return this.len === 0;
  }

  push(chunk: Buffer, onLine: (line: Buffer) => void): void {
    let rest = chunk;
    for (let nl = rest.indexOf(10); nl !== -1; nl = rest.indexOf(10)) {
      const head = rest.subarray(0, nl);
      const line = this.len ? Buffer.concat([...this.parts, head]) : head;
      // Reset first: the callback may inspect `clean`, and the line it is handed is already complete.
      this.parts = [];
      this.len = 0;
      onLine(line);
      rest = rest.subarray(nl + 1);
    }
    if (rest.length) {
      this.parts.push(rest);
      this.len += rest.length;
    }
  }
}

type Msg = {
  id?: string | number;
  method?: string;
  params?: { requestId?: string | number };
  result?: { capabilities?: Record<string, unknown>; serverInfo?: { version?: string } };
  error?: { message?: string };
};

const key = (id: unknown) => `${typeof id}:${String(id)}`;

function parse(line: Buffer): Msg | null {
  try {
    const m = JSON.parse(line.toString("utf8"));
    return m && typeof m === "object" ? (m as Msg) : null;
  } catch {
    return null;
  }
}

export interface SupervisorOptions {
  launcher: Launcher;
  /** The arguments `serve` was started with, minus `--worker`. */
  args?: string[];
  version: string;
  stdin?: Readable;
  stdout?: Writable;
  env?: Record<string, string | undefined>;
  cwd?: string;
  checkIntervalMs?: number;
  /** How long the new worker has to answer `initialize`. */
  handoverTimeoutMs?: number;
  /** How long to wait for the session to go idle once the new worker is ready. */
  idleTimeoutMs?: number;
  backoffMs?: number;
  /** SIGTERM -> SIGKILL grace for workers. */
  graceMs?: number;
  /** Client pid to watch for an orphaned supervisor. */
  clientPid?: number;
  orphanCheckMs?: number;
  readVersion?: (launcher: Launcher) => Promise<string | null>;
  onSwapped?: (swap: { from: string; to: string }) => Promise<void> | void;
  log?: (message: string) => void;
  now?: () => number;
  exit?: (code: number) => void;
}

interface Worker {
  proc: ChildProcess;
  version: string;
  retired: boolean;
  /** Output the worker produced after answering the replayed `initialize` but before it became active. */
  early: Buffer[];
  live: boolean;
}

async function defaultReadVersion(launcher: Launcher): Promise<string | null> {
  return await new Promise((resolve) => {
    try {
      const child = spawn(launcher.argv[0], [...launcher.argv.slice(1), "--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout!.on("data", (c) => (out += c));
      child.on("error", () => (clearTimeout(timer), resolve(null)));
      child.on("close", (code) => {
        clearTimeout(timer);
        const match = /\d+\.\d+\.\d+\S*/.exec(out);
        resolve(code === 0 && match ? match[0] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Runs until the client goes away or the active worker dies. Resolves with the exit code (and calls `exit`). */
export function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const baseEnv = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => process.stderr.write(`project-brain: ${m}\n`));
  const now = opts.now ?? Date.now;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const args = opts.args ?? [];
  const graceMs = opts.graceMs ?? 30_000;
  const readVersion = opts.readVersion ?? defaultReadVersion;
  const clientPid = opts.clientPid ?? (Number(baseEnv.BRAIN_CLIENT_PID) || process.ppid);

  return new Promise<number>((finish) => {
    const workers = new Set<Worker>();
    let active: Worker;
    let stopping = false;

    // Session state, shared by whichever worker is active.
    const inbound = new Set<string>(); // client requests awaiting a response
    const outbound = new Set<string>(); // server requests awaiting a response
    let initReq: (Msg & { jsonrpc: "2.0" }) | undefined;
    let initialized = false;
    let capabilities: Record<string, unknown> = {};
    const fromClient = new LineFramer();
    const fromServer = new LineFramer();
    const idle = () => inbound.size === 0 && outbound.size === 0 && fromClient.clean && fromServer.clean;

    const spawnWorker = (extraEnv: Record<string, string> = {}): ChildProcess =>
      spawn(opts.launcher.argv[0], [...opts.launcher.argv.slice(1), ...args, "--worker"], {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "inherit"],
        // The worker's orphan check must watch THIS process, not the client above it.
        env: { ...baseEnv, BRAIN_CLIENT_PID: String(process.pid), ...extraEnv } as NodeJS.ProcessEnv,
      });

    const terminate = (w: Worker) => {
      w.retired = true;
      try {
        w.proc.stdin?.end();
      } catch {}
      w.proc.kill("SIGTERM");
      const t = setTimeout(() => w.proc.kill("SIGKILL"), graceMs);
      t.unref?.();
      w.proc.once("exit", () => clearTimeout(t));
    };

    const shutdown = (code: number) => {
      if (stopping) return;
      stopping = true;
      clearInterval(poll);
      clearInterval(orphan);
      const live = [...workers].filter((w) => w.proc.exitCode === null && w.proc.signalCode === null);
      let left = live.length;
      const done = () => {
        if (--left <= 0) {
          finish(code);
          exit(code);
        }
      };
      if (live.length === 0) {
        finish(code);
        exit(code);
        return;
      }
      for (const w of live) {
        w.proc.once("exit", done);
        terminate(w);
      }
      // Backstop: kill is bounded by graceMs, plus a moment for the exit events.
      setTimeout(() => (finish(code), exit(code)), graceMs + 2000).unref?.();
    };

    // ---- relay -----------------------------------------------------------

    const trackClient = (line: Buffer) => {
      const m = parse(line);
      if (!m) return;
      if (m.method && m.id !== undefined) {
        inbound.add(key(m.id));
        if (m.method === "initialize" && !initReq) initReq = m as unknown as typeof initReq;
      } else if (m.method === "notifications/initialized") initialized = true;
      else if (m.method === "notifications/cancelled") inbound.delete(key(m.params?.requestId));
      else if (!m.method && m.id !== undefined) outbound.delete(key(m.id));
    };

    const trackServer = (line: Buffer) => {
      const m = parse(line);
      if (!m) return;
      if (m.method && m.id !== undefined) outbound.add(key(m.id));
      else if (m.method === "notifications/cancelled") outbound.delete(key(m.params?.requestId));
      else if (!m.method && m.id !== undefined) {
        inbound.delete(key(m.id));
        if (initReq && m.id === initReq.id && m.result?.capabilities) capabilities = m.result.capabilities;
      }
    };

    const attach = (w: Worker) => {
      workers.add(w);
      w.proc.stdin!.on("error", () => {});
      w.proc.on("error", (e) => {
        if (!w.retired && !stopping) {
          log(`could not run the server: ${e.message}`);
          shutdown(1);
        }
      });
      w.proc.stdout!.on("data", (chunk: Buffer) => {
        if (w !== active || stopping) return; // a retired worker no longer speaks
        fromServer.push(chunk, trackServer);
        if (!stdout.write(chunk)) {
          w.proc.stdout!.pause();
          stdout.once("drain", () => w.proc.stdout!.resume());
        }
        // Only now, with the whole chunk forwarded: a response must reach the client before the
        // list_changed it enables, and a half-sent line in this chunk must finish on this worker.
        maybeCutover();
      });
      w.proc.on("exit", (code, signal) => {
        workers.delete(w);
        if (w.retired || stopping) return;
        log(`server ${w.version} exited (${signal ?? `code ${code}`}); closing this connection`);
        shutdown(code ?? 1);
      });
    };

    stdin.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      fromClient.push(buf, trackClient);
      if (!active.proc.stdin!.write(buf)) {
        stdin.pause();
        active.proc.stdin!.once("drain", () => stdin.resume());
      }
    });
    stdin.on("end", () => shutdown(0));
    stdout.on("error", () => shutdown(0));
    stdin.on("error", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGHUP", () => shutdown(0));
    process.on("SIGINT", () => shutdown(0));
    process.on("exit", () => {
      for (const w of workers) w.proc.kill("SIGKILL");
    });

    const orphan = setInterval(() => {
      try {
        process.kill(clientPid, 0);
      } catch {
        shutdown(0);
      }
    }, opts.orphanCheckMs ?? 30_000);
    orphan.unref?.();

    // ---- swap ------------------------------------------------------------

    let baseline = launcherSignature(opts.launcher.watch);
    let target: string | null = null;
    let preparing = false;
    let ready: Worker | null = null;
    const backoff = new Map<string, number>();
    // A version that keeps failing is given up on for this session instead of being retried forever.
    const attempts = new Map<string, number>();
    const MAX_ATTEMPTS = 2;

    const check = async () => {
      if (stopping || preparing || ready) return;
      const signature = launcherSignature(opts.launcher.watch);
      if (signature !== null && signature !== baseline) {
        const version = await readVersion(opts.launcher);
        // Unreadable usually means the install is still writing; look again next tick.
        if (version !== null) {
          baseline = signature;
          if (isNewer(version, opts.version)) target = version;
        }
      }
      if (target && isNewer(target, active.version) && (backoff.get(target) ?? 0) <= now() && (attempts.get(target) ?? 0) < MAX_ATTEMPTS) void prepare(target);
    };
    const poll = setInterval(() => void check(), opts.checkIntervalMs ?? 30_000);
    poll.unref?.();

    const prepare = async (to: string) => {
      if (preparing || !initReq || !initialized) return;
      preparing = true;
      const startedAt = now();
      const proc = spawnWorker();
      const next: Worker = { proc, version: to, retired: false, early: [], live: false };
      workers.add(next);
      try {
        await handshake(next);
        ready = next;
        const deadline = now() + (opts.idleTimeoutMs ?? 120_000);
        while (!stopping && ready === next && !maybeCutover(startedAt)) {
          if (next.proc.exitCode !== null || next.proc.signalCode !== null) throw new Error("new server died while waiting for an idle moment");
          if (now() > deadline) throw new Error("session never went idle");
          await new Promise((r) => setTimeout(r, 25));
        }
      } catch (error) {
        if (ready === next) ready = null;
        workers.delete(next);
        proc.kill("SIGKILL");
        backoff.set(to, now() + (opts.backoffMs ?? 10 * 60_000));
        attempts.set(to, (attempts.get(to) ?? 0) + 1);
        log(`hot swap to ${to} failed, staying on ${active.version}: ${(error as Error).message}`);
      } finally {
        preparing = false;
      }
    };

    /** Replay `initialize` into the new worker; resolves once it answered with the version we expect. */
    const handshake = (w: Worker) =>
      new Promise<void>((resolve, reject) => {
        const replayId = `hot-swap-init-${now()}`;
        let acc: Buffer = Buffer.alloc(0);
        const timer = setTimeout(() => fail(new Error("timed out waiting for the new server to initialize")), opts.handoverTimeoutMs ?? 10_000);
        let settled = false;
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        };
        w.proc.on("error", fail);
        w.proc.on("exit", (code) => fail(new Error(`new server exited early (code ${code})`)));
        w.proc.stdin!.on("error", fail);
        w.proc.stdout!.on("data", (chunk: Buffer) => {
          if (w.live) return; // attach() relays from here on
          if (settled) {
            w.early.push(chunk);
            return;
          }
          acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
          for (let nl = acc.indexOf(10); nl !== -1 && !settled; nl = acc.indexOf(10)) {
            const m = parse(acc.subarray(0, nl));
            acc = acc.subarray(nl + 1);
            if (!m || m.id !== replayId || m.method) continue;
            if (m.error) return fail(new Error(`new server rejected initialize: ${m.error.message ?? "unknown"}`));
            const reported = m.result?.serverInfo?.version;
            if (reported !== w.version) return fail(new Error(`new server reports ${reported}, expected ${w.version}`));
            if (!isNewer(reported, active.version)) return fail(new Error(`${reported} is not newer than ${active.version}`));
            settled = true;
            clearTimeout(timer);
            // The replayed response is discarded; whatever the worker sends after it is kept for the cutover.
            if (acc.length) w.early.push(acc);
            w.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            resolve();
          }
        });
        w.proc.stdin!.write(`${JSON.stringify({ ...initReq, id: replayId })}\n`);
      });

    /** Atomic: runs synchronously, only when nothing is in flight and no line is half-sent either way. */
    const maybeCutover = (startedAt = now()): boolean => {
      const next = ready;
      if (!next || stopping || !idle() || next.proc.exitCode !== null || next.proc.signalCode !== null) return false;
      const old = active;
      active = next;
      ready = null;
      // From here the relay targets the new worker. What it said while waiting for this moment is
      // forwarded first, in order; after that attach()'s handler speaks for it.
      attach(next);
      next.live = true;
      for (const chunk of next.early.splice(0)) {
        fromServer.push(chunk, trackServer);
        stdout.write(chunk);
      }
      old.proc.stdout!.pause();
      terminate(old);
      stdin.resume();
      const notify = (method: string) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
      notify("notifications/tools/list_changed");
      if (capabilities.prompts) notify("notifications/prompts/list_changed");
      if (capabilities.resources) notify("notifications/resources/list_changed");
      log(`hot-swapped ${old.version} -> ${next.version} in ${now() - startedAt}ms`);
      void (async () => opts.onSwapped?.({ from: old.version, to: next.version }))().catch(() => {});
      return true;
    };

    // ---- start -----------------------------------------------------------

    active = { proc: spawnWorker(), version: opts.version, retired: false, early: [], live: true };
    attach(active);
  });
}
