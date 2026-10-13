// Hot swap for the stdio MCP server.
//
// Claude Code does not reconnect a stdio server after its binary changes, so a
// session that outlives `project-brain update` keeps serving the old code until
// the user runs `/mcp reconnect`. This transport lets the running process hand
// its client over to the new binary instead, without the client noticing more
// than a `tools/list_changed`.
//
// It replaces StdioServerTransport rather than sharing stdin with it: the SDK
// transport counts stdin listeners to decide whether to pause the stream, and a
// second reader loses bytes. Owning the single `data` listener for the whole
// life of the process is what makes the takeover byte-exact — the chunks that
// reach the old server and the chunks relayed to the new one come from the same
// place, and the partial line in flight at the moment of the swap moves across
// with them.
//
//   serving   lines are parsed and dispatched to the old server (the SDK path).
//   handover  the new binary boots as a child and is replayed `initialize`.
//             Client bytes are held raw, so nothing is parsed twice or dropped.
//   relay     held bytes go to the child, then raw stdin -> child stdin and
//             child stdout -> stdout. The old server is never called again.
//
// Fail closed: any error or timeout before the switch kills the child, hands the
// held bytes back to the old server in order, and backs off from that version.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isNewer } from "../notifier.js";

/** Set on the child so a log line can say where it came from; the child still swaps later to anything newer. */
export const HOT_SWAP_FROM_ENV = "BRAIN_HOT_SWAP_FROM";

export interface SelfLaunch {
  /** argv that runs this same CLI without arguments; `--version` is appended to probe it. */
  base: string[];
  /** The command-line arguments this server was started with (`serve`, ...). */
  args: string[];
  /** The file whose replacement signals an update. */
  watchPath: string;
}

/** How this process was started: a compiled binary is its own CLI, `bun script.ts` needs the script too. */
export function resolveSelfLaunch(
  execPath: string = process.execPath,
  argv: string[] = process.argv
): SelfLaunch {
  const script = argv[1];
  const viaBun = /^bun(\.exe)?$/.test(basename(execPath)) && script;
  return viaBun
    ? { base: [execPath, script], args: argv.slice(2), watchPath: script }
    : { base: [execPath], args: argv.slice(2), watchPath: execPath };
}

export interface HotSwapOptions extends SelfLaunch {
  /** This process's own version. */
  version: string;
  stdin?: Readable;
  stdout?: Writable;
  env?: Record<string, string | undefined>;
  cwd?: string;
  checkIntervalMs?: number;
  handoverTimeoutMs?: number;
  /** How long a version that failed to take over is left alone. */
  backoffMs?: number;
  /** Runs once the child has answered `initialize`, just before the switch: release what only the old code needs. */
  onSwitched?: () => Promise<void> | void;
  /** Reports `<base> --version`; null when it cannot be run (e.g. mid-install). */
  readVersion?: (base: string[]) => Promise<string | null>;
  log?: (message: string) => void;
  now?: () => number;
  exit?: (code: number) => void;
}

type InitRequest = { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown };
type Phase = "serving" | "handover" | "relay";

const key = (id: unknown) => `${typeof id}:${String(id)}`;

async function defaultReadVersion(base: string[]): Promise<string | null> {
  return await new Promise((resolve) => {
    try {
      const child = spawn(base[0], [...base.slice(1), "--version"], { stdio: ["ignore", "pipe", "ignore"] });
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

export class HotSwapTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private readonly env: Record<string, string | undefined>;

  private phase: Phase = "serving";
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  private rest: Buffer = Buffer.alloc(0);
  private held: Buffer[] = [];
  private child?: ChildProcess;

  /** Client requests the old server has not answered yet, and its requests the client has not. */
  private inbound = new Set<string>();
  private outbound = new Set<string>();
  private initRequest?: InitRequest;
  private initialized = false;
  private capabilities: Record<string, unknown> = {};

  private baseline: string | null = null;
  private target: string | null = null;
  private checking = false;
  private backoff = new Map<string, number>();

  private readonly ondata = (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  private readonly onstdinerror = (error: Error) => this.onerror?.(error);

  constructor(private readonly opts: HotSwapOptions) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.log = opts.log ?? ((m) => process.stderr.write(`project-brain: ${m}\n`));
    this.now = opts.now ?? Date.now;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.env = opts.env ?? process.env;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("HotSwapTransport already started");
    this.started = true;
    this.baseline = this.signature();
    this.stdin.on("data", this.ondata);
    this.stdin.on("error", this.onstdinerror);
    this.timer = setInterval(() => void this.check(), this.opts.checkIntervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stdin.off("data", this.ondata);
    this.stdin.off("error", this.onstdinerror);
    if (this.phase !== "relay") this.child?.kill("SIGKILL");
    this.rest = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    // After the switch the child owns the conversation; the old code must not speak.
    if (this.phase === "relay") return Promise.resolve();

    const m = message as { id?: string | number; method?: string; result?: { capabilities?: Record<string, unknown> } };
    if (m.id !== undefined) {
      if (m.method) this.outbound.add(key(m.id));
      else {
        this.inbound.delete(key(m.id));
        if (m.id === this.initRequest?.id && m.result?.capabilities) this.capabilities = m.result.capabilities;
        if (this.target && this.idle()) this.scheduleSwap();
      }
    }
    return this.write(serializeMessage(message));
  }

  private write(data: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.stdout.write(data)) resolve();
      else this.stdout.once("drain", resolve);
    });
  }

  private idle(): boolean {
    return this.inbound.size === 0 && this.outbound.size === 0;
  }

  // ---- serving: the SDK's line framing, plus the bookkeeping a swap needs ----

  private receive(chunk: Buffer): void {
    if (this.phase === "relay") {
      this.child?.stdin?.write(chunk);
      return;
    }
    if (this.phase === "handover") {
      this.held.push(chunk);
      return;
    }
    this.rest = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    for (let nl = this.rest.indexOf("\n"); nl !== -1; nl = this.rest.indexOf("\n")) {
      const line = this.rest.toString("utf8", 0, nl).replace(/\r$/, "");
      this.rest = this.rest.subarray(nl + 1);
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    const m = message as { id?: string | number; method?: string; params?: { requestId?: string | number } };
    if (m.method && m.id !== undefined) {
      this.inbound.add(key(m.id));
      if (m.method === "initialize" && !this.initRequest) this.initRequest = message as unknown as InitRequest;
    } else if (m.method === "notifications/initialized") {
      this.initialized = true;
    } else if (m.method === "notifications/cancelled") {
      // The SDK answers a cancelled request with nothing, so it would otherwise look busy forever.
      this.inbound.delete(key(m.params?.requestId));
    } else if (!m.method && m.id !== undefined) {
      this.outbound.delete(key(m.id));
    }
    this.onmessage?.(message);
  }

  // ---- detecting a newer binary ----

  private signature(): string | null {
    try {
      const s = statSync(this.opts.watchPath);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  /** Cheap first (stat), `--version` only when the file changed. Public so a test can drive it. */
  async check(): Promise<void> {
    if (this.phase !== "serving" || this.checking) return;
    this.checking = true;
    try {
      const signature = this.signature();
      if (signature !== null && signature !== this.baseline) {
        const version = await (this.opts.readVersion ?? defaultReadVersion)(this.opts.base);
        // Unreadable usually means the install is still writing; look again next tick.
        if (version !== null) {
          this.baseline = signature;
          if (isNewer(version, this.opts.version)) this.target = version;
        }
      }
      if (this.target) this.scheduleSwap();
    } finally {
      this.checking = false;
    }
  }

  private scheduleSwap(): void {
    // Deferred so a swap never starts in the middle of the caller's own dispatch.
    setImmediate(() => void this.swap());
  }

  private async swap(): Promise<void> {
    const target = this.target;
    if (!target || this.phase !== "serving" || !this.initRequest || !this.initialized || !this.idle()) return;
    if ((this.backoff.get(target) ?? 0) > this.now()) return;
    if (this.opts.version === target) return;

    const startedAt = this.now();
    // The partial line in flight belongs to whoever ends up serving the rest of it.
    this.held = this.rest.length ? [this.rest] : [];
    this.rest = Buffer.alloc(0);
    this.phase = "handover";

    let child: ChildProcess | undefined;
    try {
      child = await this.handshake(target);
    } catch (error) {
      this.child?.kill("SIGKILL");
      this.child = undefined;
      this.backoff.set(target, this.now() + (this.opts.backoffMs ?? 10 * 60_000));
      this.log(`hot swap to ${target} failed, staying on ${this.opts.version}: ${(error as Error).message}`);
      this.phase = "serving";
      const held = this.held;
      this.held = [];
      for (const chunk of held) this.receive(chunk);
      return;
    }
    this.cutover(child, target, startedAt);
  }

  /** Boot the new binary and replay the handshake. Resolves with the child once it answered `initialize`. */
  private handshake(target: string): Promise<ChildProcess> {
    const { base, args, cwd, handoverTimeoutMs = 10_000 } = this.opts;
    const replayId = `hot-swap-init-${this.now()}`;
    const clientPid = Number(this.env.BRAIN_CLIENT_PID) || process.ppid;

    return new Promise((resolve, reject) => {
      const child = spawn(base[0], [...base.slice(1), ...args], {
        cwd: cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...this.env, [HOT_SWAP_FROM_ENV]: this.opts.version, BRAIN_CLIENT_PID: String(clientPid) } as NodeJS.ProcessEnv,
      });
      this.child = child;
      let settled = false;
      const decoder = new StringDecoder("utf8");
      let text = "";
      const early: Buffer[] = [];
      let answered = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("timed out waiting for the new server to initialize")), handoverTimeoutMs);

      child.on("error", (e) => fail(e));
      child.on("exit", (code) => fail(new Error(`new server exited early (code ${code})`)));
      child.stdin!.on("error", (e) => fail(e));

      const onData = (chunk: Buffer) => {
        if (answered) {
          early.push(chunk);
          return;
        }
        text += decoder.write(chunk);
        for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n")) {
          const line = text.slice(0, nl);
          text = text.slice(nl + 1);
          let msg: { id?: unknown; method?: string; error?: { message?: string }; result?: { serverInfo?: { version?: string } } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== replayId || msg.method) continue;
          if (msg.error) return fail(new Error(`new server rejected initialize: ${msg.error.message ?? "unknown"}`));
          const reported = msg.result?.serverInfo?.version;
          if (reported === this.opts.version) return fail(new Error(`new server reports the same version (${reported})`));
          answered = true;
          if (text) early.push(Buffer.from(text, "utf8"));
          // The replayed response is discarded; the client already has the real one.
          child.stdin!.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
          void this.release().then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout!.off("data", onData);
            child.stdout!.pause();
            this.early = early;
            resolve(child);
          });
        }
      };
      child.stdout!.on("data", onData);

      const init = { ...this.initRequest!, id: replayId };
      child.stdin!.write(serializeMessage(init as JSONRPCMessage));
      this.log(`hot swap to ${target}: replaying initialize`);
    });
  }

  private early: Buffer[] = [];

  private async release(): Promise<void> {
    try {
      await this.opts.onSwitched?.();
    } catch (error) {
      this.log(`releasing the old server failed (continuing): ${(error as Error).message}`);
    }
  }

  /** Synchronous and infallible by construction: nothing in here awaits or throws before the relay is live. */
  private cutover(child: ChildProcess, target: string, startedAt: number): void {
    this.phase = "relay";
    if (this.timer) clearInterval(this.timer);

    child.removeAllListeners("exit");
    child.on("exit", (code, signal) => {
      this.log(`new server (${target}) exited after the swap (${signal ?? `code ${code}`}); closing this connection`);
      this.exit(code ?? 1);
    });
    child.stdin!.on("error", (e) => this.log(`relay to new server failed: ${e.message}`));
    process.once("exit", () => child.kill("SIGKILL"));

    for (const chunk of this.held) child.stdin!.write(chunk);
    this.held = [];
    this.stdin.once("end", () => child.stdin!.end());

    for (const chunk of this.early) this.stdout.write(chunk);
    this.early = [];
    child.stdout!.on("data", (chunk: Buffer) => this.stdout.write(chunk));
    child.stdout!.resume();

    const notify = (method: string) => this.stdout.write(serializeMessage({ jsonrpc: "2.0", method } as JSONRPCMessage));
    notify("notifications/tools/list_changed");
    if (this.capabilities.prompts) notify("notifications/prompts/list_changed");
    if (this.capabilities.resources) notify("notifications/resources/list_changed");

    this.log(`hot-swapped ${this.opts.version} -> ${target} in ${this.now() - startedAt}ms`);
  }
}
