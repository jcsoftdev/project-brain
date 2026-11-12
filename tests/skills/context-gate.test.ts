import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_GATE_HEALTH_FILE,
  MAX_SEGMENTS,
  judgeContext,
  parseContextInput,
  recordContextGateHealth,
} from "../../src/skills/context-gate.js";
import { runContextSuggest } from "../../src/commands/suggest.js";

type Sent = { state: { prompt: string; contexts: string[] }; questions: Record<string, { type: string }> };

function jev(scores: number[]) {
  const sent: Sent[] = [];
  const fetchFn = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Sent;
    sent.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((key, i) => [key, { type: "noul", noul: scores[i] }]));
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  return { sent, fetchFn };
}

const token = async () => "ts_live_abcdef123";

describe("judgeContext", () => {
  it("asks once for every segment and keeps a score of 0.5 or above", async () => {
    const { sent, fetchFn } = jev([0.49, 0.5, 0.9]);
    const verdict = await judgeContext({ prompt: "summarise math.ts", segments: ["a", "b", "c"] }, { getToken: token, fetchFn });
    expect(verdict).toEqual({ scores: [0.49, 0.5, 0.9], keep: [false, true, true] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state.contexts).toEqual(["a", "b", "c"]);
    expect(Object.values(sent[0]!.questions).every((q) => q.type === "noul")).toBe(true);
  });

  it("keeps the segments past the cap without asking about them", async () => {
    const segments = Array.from({ length: MAX_SEGMENTS + 2 }, (_, i) => `s${i}`);
    const { sent, fetchFn } = jev(Array(MAX_SEGMENTS).fill(0.1));
    const verdict = (await judgeContext({ prompt: "p", segments }, { getToken: token, fetchFn }))!;
    expect(Object.keys(sent[0]!.questions)).toHaveLength(MAX_SEGMENTS);
    expect(verdict.keep.slice(MAX_SEGMENTS)).toEqual([true, true]);
    expect(verdict.scores.slice(MAX_SEGMENTS)).toEqual([null, null]);
  });

  it("returns null without a token, without a prompt, or when Jev fails, and records health", async () => {
    const health: boolean[] = [];
    const recordHealth = async (ok: boolean) => void health.push(ok);
    expect(await judgeContext({ prompt: "p", segments: ["a"] }, { getToken: async () => null })).toBeNull();
    expect(await judgeContext({ prompt: "  ", segments: ["a"] }, { getToken: token })).toBeNull();
    const down = async () => new Response("down", { status: 503 });
    expect(await judgeContext({ prompt: "p", segments: ["a"] }, { getToken: token, fetchFn: down, recordHealth })).toBeNull();
    expect(health).toEqual([false]);
  });
});

describe("parseContextInput", () => {
  it("takes a prompt and string segments, and nothing else", () => {
    expect(parseContextInput('{"prompt":"p","segments":["a"]}')).toEqual({ prompt: "p", segments: ["a"] });
    expect(parseContextInput('{"prompt":"p","segments":["a",1]}')).toBeNull();
    expect(parseContextInput("{nope")).toBeNull();
  });
});

describe("runContextSuggest", () => {
  it("prints one JSON verdict line, or nothing when it could not judge", async () => {
    const printed: string[] = [];
    const { fetchFn } = jev([0.2]);
    await runContextSuggest('{"prompt":"p","segments":["a"]}', { print: (t) => printed.push(t), getToken: token, fetchFn });
    expect(printed.map((l) => JSON.parse(l))).toEqual([{ scores: [0.2], keep: [false] }]);
    await runContextSuggest("{nope", { print: (t) => printed.push(t), getToken: token, fetchFn });
    expect(printed).toHaveLength(1);
  });
});

describe("recordContextGateHealth", () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), "pb-gate-health-"))));
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const failures = async () => JSON.parse(await readFile(join(dir, CONTEXT_GATE_HEALTH_FILE), "utf8")).failures;

  it("counts failures in a row and resets on success", async () => {
    await recordContextGateHealth(dir, false, 1);
    await recordContextGateHealth(dir, false, 2);
    expect(await failures()).toBe(2);
    await recordContextGateHealth(dir, true, 3);
    expect(await failures()).toBe(0);
  });
});
