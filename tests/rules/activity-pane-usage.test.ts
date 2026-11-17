import { beforeAll, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number };
type StepUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};
type AgentUsage = { input: number; output: number; cacheWrite: number; cacheRead: number; usd: number | null };
type Span = { text: string; dim?: boolean; color?: string };
type Row = { key: string; cells: { spans: Span[] }[]; right?: Span[] };

interface PaneModule {
  priceOf(modelId: string, promptTokens?: number): Rates | null;
  costOf(usage: StepUsage, modelId: string): number | null;
  addUsage(all: Record<string, AgentUsage>, agentId: string, usage: StepUsage | undefined, modelId: string): Record<string, AgentUsage>;
  estimatedUsd(usd: number): string;
  usageRight(usage: AgentUsage | undefined, base: string, width: number): string;
}

interface RunningModule {
  rowsRunning(part: unknown, ctx: { width: number; accent: string; isOpen: (key: string, byDefault: boolean) => boolean }): Row[];
}

const HOOKS = join(import.meta.dir, "../../templates/claude-tui/activity-pane/hooks");

let pane: PaneModule;
let running: RunningModule;
beforeAll(async () => {
  mock.module("claude-code", () => ({ atom: (_ref: unknown, initial: unknown) => ({ initial }), read: async () => undefined, update: async () => undefined }));
  mock.module("react/jsx-dev-runtime", () => ({ jsxDEV: () => null, Fragment: "fragment" }));
  pane = (await import(join(HOOKS, "register.tsx"))) as PaneModule;
  running = (await import(join(HOOKS, "feat-running.tsx"))) as RunningModule;
});

const MILLION = 1_000_000;
const step = (input: number, cacheWrite: number, cacheRead: number, output: number): StepUsage => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
});

describe("activity pane pricing", () => {
  it.each([
    ["claude-opus-5-5", 4 + 5 + 0.2 + 20],
    ["claude-opus-5-5[1m]", 4 + 5 + 0.2 + 20],
    ["claude-sonnet-5-5", 2 + 2.5 + 0.1 + 10],
    ["claude-sonnet-4-5-20250929", 3 + 3.75 + 0.3 + 15],
    ["claude-opus-4-1-20250805", 15 + 18.75 + 1.5 + 75],
    ["claude-fable-5-2", 8 + 10 + 0.2 + 40],
  ])("%p prices a million of each kind at %p USD", (model, usd) => {
    expect(pane.costOf(step(MILLION, MILLION, MILLION, MILLION), model)).toBeCloseTo(usd, 9);
  });

  it("prices Haiku 5.5 by the request's prompt size", () => {
    expect(pane.costOf(step(40_000, 30_000, 30_000, 1_000), "claude-haiku-5-5")).toBeCloseTo((40_000 * 0.1 + 30_000 * 0.125 + 30_000 * 0.01 + 1_000 * 0.5) / MILLION, 12);
    expect(pane.costOf(step(40_000, 30_000, 30_001, 1_000), "claude-haiku-5-5")).toBeCloseTo((40_000 * 0.5 + 30_000 * 0.625 + 30_001 * 0.05 + 1_000 * 2.5) / MILLION, 12);
  });

  it("gives no price to a model the list does not name", () => {
    expect(pane.priceOf("qwen3.5:4b")).toBeNull();
    expect(pane.priceOf("")).toBeNull();
    expect(pane.costOf(step(1000, 0, 0, 1000), "claude-mystery-9")).toBeNull();
  });

  it("reads null or absent cache fields as zero", () => {
    const usd = pane.costOf({ input_tokens: MILLION, output_tokens: MILLION, cache_creation_input_tokens: null }, "claude-opus-5-5");
    expect(usd).toBeCloseTo(24, 9);
  });
});

describe("activity pane usage totals", () => {
  it("adds every step of a loop, each at its own model's price", () => {
    let all: Record<string, AgentUsage> = {};
    all = pane.addUsage(all, "a1", step(MILLION, 0, 0, 0), "claude-opus-5-5");
    all = pane.addUsage(all, "a1", { input_tokens: 0, cache_read_input_tokens: MILLION, cache_creation_input_tokens: null, output_tokens: MILLION }, "claude-sonnet-5-5");
    all = pane.addUsage(all, "a1", undefined, "claude-opus-5-5");
    all = pane.addUsage(all, "main", step(10, 0, 0, 0), "claude-opus-5-5");
    expect(all.a1).toEqual({ input: MILLION, output: MILLION, cacheWrite: 0, cacheRead: MILLION, usd: expect.closeTo(4 + 0.1 + 10, 9) });
    expect(all.main?.input).toBe(10);
  });

  it("drops the price for good once a step's model has none, and keeps counting tokens", () => {
    let all = pane.addUsage({}, "a1", step(1000, 0, 0, 0), "claude-opus-5-5");
    all = pane.addUsage(all, "a1", step(1000, 0, 0, 0), "qwen3.5:4b");
    all = pane.addUsage(all, "a1", step(1000, 0, 0, 0), "claude-opus-5-5");
    expect(all.a1?.usd).toBeNull();
    expect(all.a1?.input).toBe(3000);
  });
});

describe("activity pane usage label", () => {
  const spent = (usd: number | null): AgentUsage => ({ input: 2_000, output: 10_000, cacheWrite: 100_000, cacheRead: 300_000, usd });

  it.each([
    [1.8449, "~$1.84"],
    [0.1, "~$0.10"],
    [0.0456, "~$0.046"],
    [0.001, "~$0.001"],
    [0.0004, "<$0.001"],
  ])("writes %p USD as %p", (usd, text) => {
    expect(pane.estimatedUsd(usd)).toBe(text);
  });

  it("drops the price before the tokens, and the tokens before the duration, as the row narrows", () => {
    expect(pane.usageRight(spent(1.84), "36m 01s", 80)).toBe("412k tok · ~$1.84   ");
    expect(pane.usageRight(spent(1.84), "36m 01s", 40)).toBe("412k tok   ");
    expect(pane.usageRight(spent(1.84), "36m 01s", 30)).toBe("");
  });

  it("shows tokens alone when the price is unknown, and nothing without usage", () => {
    expect(pane.usageRight(spent(null), "36m 01s", 80)).toBe("412k tok   ");
    expect(pane.usageRight(undefined, "36m 01s", 80)).toBe("");
    expect(pane.usageRight({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 }, "36m 01s", 80)).toBe("");
  });

  it("puts an agent's usage before its duration, and leaves a command row alone", () => {
    const now = 1_000_000;
    const part = {
      now,
      tasks: [
        { id: "agent1", kind: "agent", label: "review the diff", status: "running", startedAt: now - 2_161_000 },
        { id: "shell1", kind: "bash", label: "bun test", status: "running", startedAt: now - 5_000 },
      ],
      usage: { agent1: spent(1.84), shell1: spent(1.84) },
    };
    const rows = running.rowsRunning(part, { width: 80, accent: "purple", isOpen: () => true });
    const right = (key: string) => rows.find(row => row.key === key)?.right?.map(one => one.text).join("");
    expect(right("running-agent1")).toBe("412k tok · ~$1.84   36m 01s");
    expect(rows.find(row => row.key === "running-agent1")?.right?.[0]?.dim).toBe(true);
    expect(right("running-shell1")).toBe("5 s");
  });
});
