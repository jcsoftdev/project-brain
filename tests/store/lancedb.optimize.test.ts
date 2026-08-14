import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";

const DIM = 8;

/**
 * Regression cover for the runaway-optimize bug: a `Promise.race` timeout
 * abandoned the await without cancelling lance's underlying operation, so every
 * sync stacked another optimize on the same dataset. Three of them ran for 16h+
 * of CPU each and grew _indices to 181GB against 3GB of actual content.
 */
describe("LanceDbStore.optimize", () => {
  let dir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-optimize-"));
    store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "fake", dim: DIM });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Replace the cached table's optimize with a spy, returning its record. */
  async function spyOnTableOptimize(impl?: () => Promise<unknown>) {
    const table: any = await (store as any).getTable("proj");
    const calls: any[] = [];
    let live = 0;
    let maxLive = 0;
    table.optimize = async (opts: any) => {
      calls.push(opts);
      live++;
      maxLive = Math.max(maxLive, live);
      try {
        return impl ? await impl() : undefined;
      } finally {
        live--;
      }
    };
    return {
      calls,
      get maxLive() {
        return maxLive;
      },
    };
  }

  it("passes an explicit cleanupOlderThan so old versions are actually pruned", async () => {
    const spy = await spyOnTableOptimize();

    await store.optimize("proj");

    expect(spy.calls).toHaveLength(1);
    // Without this, lance keeps every version — 15,873 of them accumulated in
    // the field before this was fixed.
    expect(spy.calls[0]?.cleanupOlderThan).toBeInstanceOf(Date);
  });

  it("never runs two optimizes against the same table at once", async () => {
    const spy = await spyOnTableOptimize(
      () => new Promise((resolve) => setTimeout(resolve, 40))
    );

    await Promise.all([
      store.optimize("proj"),
      store.optimize("proj"),
      store.optimize("proj"),
    ]);

    // The pile-up is the whole disk-filling mechanism: each sync launched
    // another optimize over a dataset the previous one was still rewriting.
    expect(spy.maxLive).toBe(1);
    // Coalesced, not queued. Running optimize twice back-to-back is the wasted
    // work we are removing, and it is idempotent maintenance — the in-flight
    // run already covers whatever the later callers wanted.
    expect(spy.calls).toHaveLength(1);
  });

  it("does not resolve until the underlying optimize has settled", async () => {
    let settle: (() => void) | undefined;
    const spy = await spyOnTableOptimize(
      () => new Promise<void>((resolve) => { settle = resolve; })
    );

    let done = false;
    const pending = store.optimize("proj").then(() => { done = true; });

    // Give the microtask queue room; the call must still be in flight.
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);

    settle!();
    await pending;
    expect(done).toBe(true);
    expect(spy.calls).toHaveLength(1);
  });

  it("keeps a failing optimize non-fatal and releases the lock for the next call", async () => {
    let attempt = 0;
    const spy = await spyOnTableOptimize(async () => {
      attempt++;
      if (attempt === 1) throw new Error("synthetic optimize failure");
    });

    await store.optimize("proj"); // must not throw
    await store.optimize("proj");

    expect(spy.calls).toHaveLength(2);
  });
});

describe("LanceDbStore.optimize — cross-process lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-optimize-xp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Two stores over one dbPath stand in for two `serve` processes — every
   * MCP host starts its own, and two on one project is normal, not an edge
   * case. The in-process map is per-instance, so it cannot help here. */
  async function makeStore() {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "fake", dim: DIM });
    const table: any = await (store as any).getTable("proj");
    const calls: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    table.optimize = async () => { calls.push(1); await gate; };
    return { store, calls, release };
  }

  it("a second process skips its optimize while the first holds the lock", async () => {
    const a = await makeStore();
    const b = await makeStore();

    const first = a.store.optimize("proj");
    await new Promise((r) => setTimeout(r, 20)); // let A take the lock

    await b.store.optimize("proj"); // must return promptly, doing nothing
    expect(b.calls).toHaveLength(0);

    a.release();
    await first;
    expect(a.calls).toHaveLength(1);
  });

  it("releases the lock so a later run can take it", async () => {
    const a = await makeStore();
    a.release();
    await a.store.optimize("proj");

    const b = await makeStore();
    b.release();
    await b.store.optimize("proj");

    expect(b.calls).toHaveLength(1);
  });

  it("takes over a lock left behind by a killed process", async () => {
    // Exactly what happened in the field: three optimizes were kill -9'd
    // mid-run. A lock that survived them would wedge optimize forever.
    const stale = JSON.stringify({ pid: 999999, at: Date.now() - 2 * 60 * 60 * 1000 });
    await Bun.write(join(dir, "proj_chunks.optimize.lock"), stale);

    const a = await makeStore();
    a.release();
    await a.store.optimize("proj");

    expect(a.calls).toHaveLength(1);
  });
});
