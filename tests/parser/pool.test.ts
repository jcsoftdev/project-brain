import { test, expect } from "bun:test";
import { ParserPool, POOL_MIN_FILES } from "../../src/parser/pool.js";

test("POOL_MIN_FILES is a positive threshold", () => {
  expect(POOL_MIN_FILES).toBeGreaterThan(0);
});

test("ParserPool.parseOne parses a single file and returns its symbols", async () => {
  const pool = new ParserPool(2);
  try {
    const result = await pool.parseOne({
      path: "add.ts",
      content: "export function add(a: number, b: number) { return a + b; }",
      ext: ".ts",
    });
    expect(result.error).toBeUndefined();
    expect(result.langId).toBe("typescript");
    expect(result.symbols.some((s) => s.name === "add")).toBe(true);
  } finally {
    pool.dispose();
  }
});

test("ParserPool.parseMany processes more jobs than the pool size, all complete correctly", async () => {
  const pool = new ParserPool(2);
  try {
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      path: `file${i}.ts`,
      content: `export function fn${i}() { return ${i}; }`,
      ext: ".ts",
    }));
    const results = await pool.parseMany(jobs);
    expect(results.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(results[i].path).toBe(`file${i}.ts`);
      expect(results[i].symbols.some((s) => s.name === `fn${i}`)).toBe(true);
    }
  } finally {
    pool.dispose();
  }
});

test("ParserPool.parseMany output matches sequential WasmParser output (parity)", async () => {
  const { WasmParser } = await import("../../src/parser/wasm.js");
  const { extract } = await import("../../src/parser/extract.js");

  const files = [
    { path: "a.ts", content: "export function a() { return b(); }", ext: ".ts" },
    { path: "b.ts", content: "export function b() { return 1; }", ext: ".ts" },
  ];

  // Sequential (existing) path
  const sequential = new WasmParser();
  await sequential.init();
  const sequentialResults: Array<{ path: string; names: string[] }> = [];
  for (const f of files) {
    await sequential.warm(f.ext);
    const pt = sequential.parseFile(f.ext, f.content)!;
    const symbols = extract(pt.tree, pt.langId, f.content);
    pt.tree.delete();
    sequentialResults.push({ path: f.path, names: symbols.map((s) => s.name).sort() });
  }
  sequential.dispose();

  // Pool path
  const pool = new ParserPool(2);
  const poolResults = await pool.parseMany(files);
  pool.dispose();

  for (let i = 0; i < files.length; i++) {
    expect(poolResults[i].symbols.map((s) => s.name).sort()).toEqual(sequentialResults[i].names);
  }
});

test("ParserPool.parseOne returns serializable AST boundaries alongside symbols", async () => {
  const pool = new ParserPool(2);
  try {
    const result = await pool.parseOne({
      path: "add.ts",
      content: "export function add(a: number, b: number) { return a + b; }",
      ext: ".ts",
    });
    expect(result.error).toBeUndefined();
    expect(result.boundaries.some((b) => b.name === "add")).toBe(true);
    // Worker → main-thread messages are structured-clone/JSON safe — the
    // boundaries must survive a JSON roundtrip identically (no Node/Tree refs).
    expect(JSON.parse(JSON.stringify(result.boundaries))).toEqual(result.boundaries);
  } finally {
    pool.dispose();
  }
});

test("ParserPool never spawns more workers than its configured size", async () => {
  const pool = new ParserPool(3);
  try {
    // Internal invariant check via the pool's own worker count, not timing.
    expect((pool as any).workers.length).toBe(3);
  } finally {
    pool.dispose();
  }
});

/**
 * Regression coverage for commit bd0e56d: `worker.onerror` (Worker fails to
 * load/instantiate) is a DIFFERENT failure path than `worker.onmessage`
 * receiving a `ParseFailure` (worker loaded fine, a parse threw — see
 * worker.test.ts). Before bd0e56d, a worker that errored out never posted a
 * response for its pending job, so that job's promise hung forever — the
 * catastrophic hang this fix prevents.
 *
 * This test exercises the pool's OWN `worker.onerror` closure and the
 * dead-pool `drainQueue` guard, using ParserPool's real public API and real
 * internal bookkeeping (`pending`/`queue`/`workers`) — not a re-implementation
 * of that logic in the test. The trigger is synthetic: rather than waiting on
 * a genuine Bun Worker load failure (slow, and not something this project's
 * real worker.ts can be made to do without touching forbidden files), we
 * dispatch a real `ErrorEvent("error", ...)` directly at the pool's real
 * worker instance. `Worker` is an `EventTarget`, so this invokes the exact
 * `worker.onerror = (event) => { ... }` handler pool.ts's constructor
 * assigned — same closure, same code path a genuine load failure would hit.
 *
 * The worker's `onmessage` is also overridden to a no-op BEFORE queuing any
 * jobs. This does not touch pool.ts's error-handling logic (the thing under
 * test) — it silences the unrelated success-delivery path so the worker
 * behaves like the exact precondition the fix defends against: "a worker
 * that will never post a response for its pending job" (pool.ts's own
 * comment on `onerror`, copied above). Without this, the real worker.ts is
 * healthy and would race to answer job1 for real (WASM init is fast), making
 * the test's pass/fail depend on timing instead of on the onerror wiring.
 *
 * What this DOES prove: if the runtime ever fires `error` on a pool worker
 * that isn't going to answer its pending job, ParserPool settles both the
 * job already assigned to that worker (via the onerror handler's `pending`
 * sweep) and any still-queued job (via the dead-pool `drainQueue` guard)
 * instead of leaving their promises hanging forever. A refactor of the
 * pending/workers bookkeeping that reintroduced the hang would fail this
 * test with a real timeout, not just a wrong-value assertion.
 *
 * What this does NOT prove: that Bun's `Worker` constructor actually emits
 * an `error` event for a genuine module-load failure in the first place —
 * that's a separate, underlying-runtime guarantee (see the supplementary
 * test below).
 */
test("ParserPool.worker.onerror settles the in-flight job AND drains queued jobs as errors instead of hanging", async () => {
  const pool = new ParserPool(1);
  try {
    const worker = (pool as any).workers[0] as Worker;
    // See the doc comment above: block real response delivery so the worker
    // behaves like one that will never answer — the exact precondition
    // worker.onerror exists to handle — making the test deterministic.
    worker.onmessage = () => {};

    // job1 gets assigned to the pool's only worker synchronously inside
    // parseOne -> drainQueue. job2 has no idle worker left, so it sits in
    // the internal queue.
    const job1 = pool.parseOne({ path: "a.ts", content: "export function a() {}", ext: ".ts" });
    const job2 = pool.parseOne({ path: "b.ts", content: "export function b() {}", ext: ".ts" });

    expect((pool as any).pending.size).toBe(1);
    expect((pool as any).queue.length).toBe(1);

    worker.dispatchEvent(
      new ErrorEvent("error", {
        message: "synthetic worker load failure",
        error: new Error("synthetic worker load failure"),
      }),
    );

    const timeout = (label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} did not settle — pool hung`)), 1000),
      );

    const [result1, result2] = await Promise.all([
      Promise.race([job1, timeout("job1 (in-flight when worker errored)")]),
      Promise.race([job2, timeout("job2 (still queued when worker errored)")]),
    ]);

    // job1 was resolved by the onerror handler's `pending` sweep.
    expect(result1.error).toBeDefined();
    expect(result1.error).toContain("worker error");

    // job2 was resolved by the dead-pool `drainQueue` guard, since the only
    // worker was removed from `this.workers` before drainQueue ran again.
    expect(result2.error).toBeDefined();
    expect(result2.error).toContain("worker pool has no live workers");

    expect((pool as any).workers.length).toBe(0);
  } finally {
    pool.dispose();
  }
});

/**
 * Supplementary test — NOT a substitute for the test above. This only
 * proves the underlying Bun mechanism pool.ts depends on (a Worker
 * constructed against a script that fails to load fires `onerror`), by
 * constructing a raw `Worker` directly and bypassing `ParserPool` entirely.
 * It says nothing about ParserPool's own bookkeeping.
 */
test("(supplementary, underlying-mechanism only) a genuinely unloadable Worker script fires onerror", async () => {
  const worker = new Worker(new URL("./does-not-exist-9f3c2a.js", import.meta.url).href);
  try {
    const errored = await new Promise<boolean>((resolve) => {
      worker.onerror = () => resolve(true);
      setTimeout(() => resolve(false), 2000);
    });
    expect(errored).toBe(true);
  } finally {
    worker.terminate();
  }
});
