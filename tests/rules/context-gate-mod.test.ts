import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Piece = { text: string; allowed: boolean };
type Framed = { frame: string; pieces: Piece[] };
type Handler = (...args: any[]) => Promise<any>;

interface ModModule {
  DEFAULT_ALLOW: string[];
  MIN_PIECE_CHARS: number;
  splitAttachment(type: string, text: string, allow: readonly string[]): Framed;
  assemble(framed: Framed, dropped: ReadonlySet<number>): string | null;
  parseConfig(text: string): { enabled: boolean; allow: string[] };
  parseVerdict(stdout: string, count: number): { keep: boolean[]; scores: Array<number | null> } | null;
  register(on: (event: string, ...rest: any[]) => { catch: (fn: Handler) => void }): void;
}

const MOD_PATH = join(import.meta.dir, "../../templates/claude-tui/context-gate/hooks/register.tsx");
const NOW = Date.parse("2026-11-12T12:00:00Z");

let mod: ModModule;
beforeAll(async () => {
  mod = (await import(MOD_PATH)) as ModModule;
});

const ACME = ("ACME DEPLOY HANDBOOK. Confirm the rollout window with the on-call SRE before any deploy to the Acme cluster. ").repeat(5).trim();
const TITLE = "Name this session after the work. Write the name to `session-title` in your scratchpad directory.";
const ROUTING = "Model routing for delegated agents: load the `brain-model-routing` skill before any Agent/Task call.";
const FRAME = "SessionStart hook additional context: ";
const SESSION_START = `${FRAME}${TITLE}\n${ROUTING}\n${ACME}\n`;
const ENGRAM = `SessionStart:startup hook success: ## Engram Persistent Memory\n\n${"Call mem_save after every decision. ".repeat(20)}`;

const hookAttachment = (text: string, event = "SessionStart", type = "hook_additional_context", agentId?: string) => ({
  type,
  text,
  origin: { kind: "hook", event },
  ...(agentId ? { agentId } : {}),
});

const TOKEN = '{"token":"ts_live_abcdef123"}';
const DROP_ALL = (_argv: string[], stdin?: string) => {
  const { segments } = JSON.parse(stdin!);
  return { exitCode: 0, stdout: JSON.stringify({ keep: segments.map(() => false), scores: segments.map(() => 0.1) }), stderr: "" };
};

type Process = { turns: number; sessionId?: string };

function harness(opts: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  cli?: (argv: string[], stdin?: string) => any;
  store?: Map<string, unknown>;
  process?: Process;
  storeFails?: boolean;
}) {
  const handlers = new Map<string, Handler>();
  const runs: Array<{ argv: string[]; stdin?: string }> = [];
  const env: Record<string, string> = { HOME: "/home/u", ...opts.env };
  const files: Record<string, string> = { "/home/u/.project-brain/reranker.json": TOKEN, ...opts.files };
  const store = opts.store ?? new Map<string, unknown>();
  const proc: Process = { turns: 0, sessionId: "s1", ...opts.process };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path]!;
      },
      write: async (path: string, text: string) => void (files[path] = text),
    },
    clock: { now: async () => NOW },
    session: { id: async () => proc.sessionId!, turns: async () => proc.turns },
    store: {
      get: async (key: string) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined),
      set: async (key: string, value: unknown) => {
        if (opts.storeFails) throw new Error("store full");
        store.set(key, JSON.parse(JSON.stringify(value)));
      },
      delete: async (key: string) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        runs.push({ argv, stdin: init?.stdin });
        return opts.cli ? opts.cli(argv, init?.stdin) : { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
  mod.register((event: string, ...rest: any[]) => {
    const fn = rest[rest.length - 1] as Handler;
    handlers.set(event, fn);
    return { catch: () => {} };
  });
  const call = (event: string, e: any, next: (x: any) => Promise<any> = async (x) => x) => handlers.get(event)!($, e, next);
  const start = () => call("session.start", { cwd: "/p", surface: null, isInteractive: false });
  const submit = (text: string) => call("prompt.submit", { text });
  const attach = (e: any) => call("prompt.attachment", e, async (x) => ({ text: x.text }));
  return { call, start, submit, attach, runs, files, store, proc };
}

const firstRun = (cli = DROP_ALL, store = new Map<string, unknown>()) => harness({ cli, store });

describe("splitAttachment", () => {
  it("keeps the engine's frame, gives each allowlisted run its own piece, and joins back to the same text", () => {
    const framed = mod.splitAttachment("hook_additional_context", SESSION_START, mod.DEFAULT_ALLOW);
    expect(framed.frame).toBe(FRAME);
    expect(framed.pieces).toEqual([
      { text: `${TITLE}\n${ROUTING}`, allowed: true },
      { text: `${ACME}\n`, allowed: false },
    ]);
    expect(mod.assemble(framed, new Set())).toBe(SESSION_START);
  });

  it("reads a hook_success attachment as one hook's output, whole", () => {
    const framed = mod.splitAttachment("hook_success", ENGRAM, mod.DEFAULT_ALLOW);
    expect(framed.pieces).toHaveLength(1);
    expect(framed.pieces[0]!.allowed).toBe(true);
  });

  it("leaves the attachment out when nothing but blank text would remain", () => {
    const framed = mod.splitAttachment("hook_additional_context", `${FRAME}${ACME}`, mod.DEFAULT_ALLOW);
    expect(mod.assemble(framed, new Set([0]))).toBeNull();
  });
});

describe("parseConfig and parseVerdict", () => {
  it("adds the owner's contextAllow to the default allowlist, and contextGate false turns it off", () => {
    expect(mod.parseConfig('{"contextAllow":["kanbai"," "]}').allow).toEqual([...mod.DEFAULT_ALLOW, "kanbai"]);
    expect(mod.parseConfig('{"contextGate":false}').enabled).toBe(false);
    expect(mod.parseConfig("{nope").enabled).toBe(true);
  });

  it("reads the CLI's last line and refuses a verdict of the wrong length", () => {
    expect(mod.parseVerdict('noise\n{"keep":[false],"scores":[0.2]}\n', 1)).toEqual({ keep: [false], scores: [0.2] });
    expect(mod.parseVerdict('{"keep":[false,true]}', 1)).toBeNull();
    expect(mod.parseVerdict("", 1)).toBeNull();
  });
});

describe("the gate", () => {
  it("golden: asks once with the prompt and the unlisted piece, drops it, keeps the frame and the allowlisted lines", async () => {
    const run = firstRun();
    await run.start();
    await run.submit("list the files here and summarise math.ts");
    const out = await run.attach(hookAttachment(SESSION_START));
    expect(out.text).toBe(`${FRAME}${TITLE}\n${ROUTING}`);
    expect(run.runs).toHaveLength(1);
    expect(run.runs[0]!.argv).toEqual(["project-brain", "suggest", "--context", "--stdin"]);
    expect(JSON.parse(run.runs[0]!.stdin!)).toEqual({ prompt: "list the files here and summarise math.ts", segments: [`${ACME}\n`] });
    const log = JSON.parse(run.files["/home/u/.project-brain/context-gate-log.json"]!).dropped;
    expect(log).toEqual([{ at: NOW, session: "s1", type: "hook_additional_context", event: "SessionStart", chars: ACME.length + 1, score: 0.1, head: ACME.slice(0, 160) }]);
  });

  it("leaves out an attachment whose every piece was dropped", async () => {
    const run = firstRun();
    await run.start();
    await run.submit("summarise math.ts");
    expect(await run.attach(hookAttachment(`UserPromptSubmit hook additional context: ${ACME}`, "UserPromptSubmit"))).toEqual({ text: null });
  });

  it("replays every answer on resume, byte for byte, with no Jev call, whatever the new prompt or the config says now", async () => {
    const store = new Map<string, unknown>();
    const first = firstRun(DROP_ALL, store);
    await first.start();
    await first.submit("summarise math.ts");
    const kept = hookAttachment(ENGRAM, "SessionStart", "hook_success");
    const sent = [await first.attach(hookAttachment(SESSION_START)), await first.attach(kept)];

    const resumed = harness({
      store,
      process: { turns: 1 },
      files: { "/home/u/.project-brain/skills.json": '{"contextAllow":["ACME"]}' },
      cli: () => ({ exitCode: 0, stdout: '{"keep":[true]}', stderr: "" }),
    });
    await resumed.start();
    await resumed.submit("now summarise greet.py");
    expect([await resumed.attach(hookAttachment(SESSION_START)), await resumed.attach(kept)]).toEqual(sent);
    expect(resumed.runs).toEqual([]);
  });

  it("on resume, sends history it holds no answer for unchanged, and judges again once the first turn is done", async () => {
    const resumed = harness({ cli: DROP_ALL, process: { turns: 3 } });
    await resumed.start();
    await resumed.submit("now summarise greet.py");
    const e = hookAttachment(SESSION_START);
    expect((await resumed.attach(e)).text).toBe(SESSION_START);
    expect(resumed.runs).toEqual([]);

    await resumed.call("turn.complete", { reason: "done", text: "" });
    const later = hookAttachment(`PostToolUse:Read hook additional context: ${ACME}`, "PostToolUse");
    expect(await resumed.attach(later)).toEqual({ text: null });
    expect(resumed.runs).toHaveLength(1);
  });

  it("decides again after a compaction that stands, and not after a precompute or a skip", async () => {
    const store = new Map<string, unknown>();
    const run = firstRun(DROP_ALL, store);
    await run.start();
    await run.submit("summarise math.ts");
    const e = hookAttachment(SESSION_START);
    await run.attach(e);
    await run.call("session.compact", { trigger: "precompute", messages: [] }, async () => ({ messages: [] }));
    await run.call("session.compact", { trigger: "manual", messages: [] }, async () => ({ skip: "no" }));
    await run.attach(e);
    expect(run.runs).toHaveLength(1);

    await run.call("session.compact", { trigger: "auto", messages: [] }, async () => ({ messages: [] }));
    await run.attach(e);
    expect(run.runs).toHaveLength(2);
  });

  it("never filters the allowlist, engine text or a subagent's attachments", async () => {
    const run = harness({ cli: DROP_ALL, files: { "/home/u/.project-brain/skills.json": '{"contextAllow":["acme deploy"]}' } });
    await run.start();
    await run.submit("summarise math.ts");
    for (const e of [
      hookAttachment(ENGRAM, "SessionStart", "hook_success"),
      hookAttachment(SESSION_START),
      { type: "skill_listing", text: ACME, origin: { kind: "engine" } },
      hookAttachment(`${FRAME}${"Unrelated subagent context. ".repeat(20)}`, "SubagentStart", "hook_additional_context", "a1"),
    ]) {
      expect((await run.attach(e)).text).toBe(e.text);
    }
    expect(run.runs).toEqual([]);
  });

  it("does not ask about a short piece", async () => {
    const run = firstRun();
    await run.start();
    await run.submit("summarise math.ts");
    const short = `${FRAME}${"x".repeat(mod.MIN_PIECE_CHARS - 1)}`;
    expect((await run.attach(hookAttachment(short))).text).toBe(short);
    expect(run.runs).toEqual([]);
  });

  it("fails open: a failing, slow, garbled or throwing CLI, no token, an unhealthy run, the switches off, or no prompt yet", async () => {
    const e = hookAttachment(SESSION_START);
    const setups: Array<Parameters<typeof harness>[0]> = [
      { cli: () => ({ exitCode: 1, stdout: "", stderr: "boom" }) },
      { cli: () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      { cli: () => ({ exitCode: 0, stdout: "not json", stderr: "" }) },
      { cli: () => { throw new Error("timeout"); } },
      { cli: DROP_ALL, files: { "/home/u/.project-brain/reranker.json": '{"token":""}' } },
      { cli: DROP_ALL, files: { "/home/u/.project-brain/context-gate-health.json": '{"failures":3}' } },
      { cli: DROP_ALL, env: { BRAIN_CONTEXT_GATE: "0" } },
      { cli: DROP_ALL, files: { "/home/u/.project-brain/skills.json": '{"contextGate":false}' } },
    ];
    for (const setup of setups) {
      const run = harness(setup);
      await run.start();
      await run.submit("summarise math.ts");
      expect((await run.attach(e)).text).toBe(SESSION_START);
    }
    const noPrompt = harness({ cli: DROP_ALL });
    await noPrompt.start();
    expect((await noPrompt.attach(e)).text).toBe(SESSION_START);
  });

  it("sends the text unchanged when its answer cannot be persisted", async () => {
    const run = harness({ cli: DROP_ALL, storeFails: true });
    await run.start();
    await run.submit("summarise math.ts");
    expect((await run.attach(hookAttachment(SESSION_START))).text).toBe(SESSION_START);
  });

  it("judges against the latest typed prompt, not a slash command or a meta prompt", async () => {
    const run = firstRun();
    await run.start();
    await run.submit("summarise math.ts");
    await run.call("prompt.submit", { text: "/clear", command: { name: "clear" } });
    await run.call("prompt.submit", { text: "a notification", isMeta: true });
    await run.attach(hookAttachment(SESSION_START));
    expect(JSON.parse(run.runs[0]!.stdin!).prompt).toBe("summarise math.ts");
  });

  it("never invalidates an answer it gave", async () => {
    expect(await readFile(MOD_PATH, "utf8")).not.toContain("invalidate");
  });
});
