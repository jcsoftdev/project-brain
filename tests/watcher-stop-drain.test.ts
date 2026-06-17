/**
 * FIX A: stop() must drain the in-flight sync before resolving, so the server's
 * graph.close() (which runs right after stop() resolves) cannot race a sync that
 * still holds the shared graph → use-after-close.
 *
 * The drain/cancel lifecycle lives in debounceSync (the unit FileWatcher.stop()
 * delegates to). We drive it directly with an injected slow callback.
 */
import { describe, it, expect } from "bun:test";
import { debounceSync } from "../src/watcher.js";

describe("FIX A: debounceSync drain()/cancel() lifecycle", () => {
  it("drain() resolves only AFTER the in-flight sync completes", async () => {
    let syncDone = false;
    const callback = async () => {
      // Simulate an in-flight sync that holds the shared graph for a tick.
      await new Promise((r) => setTimeout(r, 30));
      syncDone = true;
    };

    const debounced = debounceSync(callback, 5);
    debounced("a.ts");

    // Wait past the debounce so the sync chain has started but not finished.
    await new Promise((r) => setTimeout(r, 15));
    expect(syncDone).toBe(false); // sync is in-flight, not yet done

    // drain() must not resolve until the in-flight sync settles.
    await debounced.drain();
    expect(syncDone).toBe(true);
  });

  it("drain() resolves immediately when nothing is in flight", async () => {
    const debounced = debounceSync(async () => {}, 5);
    // No trigger fired → no in-flight promise.
    await debounced.drain(); // must not hang
    expect(true).toBe(true);
  });

  it("cancel() stops a pending (not-yet-fired) debounce from starting a sync", async () => {
    let fired = false;
    const debounced = debounceSync(async () => { fired = true; }, 30);
    debounced("a.ts");

    // Cancel before the debounce timer fires.
    debounced.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(fired).toBe(false); // cancelled → callback never ran
    await debounced.drain(); // still safe (nothing in flight)
  });

  it("drain() awaits an EARLIER slow run, not just the latest (overlapping waves)", async () => {
    // Regression: a single-slot `inFlight` lost the reference to run #1 when a
    // second debounce wave started, so drain() could resolve while run #1 was
    // still writing the shared graph → graph.close() use-after-close. The chain
    // must serialize runs and drain() must await ALL of them.
    const completed: string[] = [];
    const debounced = debounceSync(async (paths) => {
      // First wave is slow, second is fast — if drain awaited only the latest,
      // it would resolve before the slow first run finished.
      const slow = paths.includes("a.ts");
      await new Promise((r) => setTimeout(r, slow ? 40 : 5));
      completed.push(slow ? "run1" : "run2");
    }, 5);

    debounced("a.ts");
    await new Promise((r) => setTimeout(r, 15)); // let wave 1 fire + start (still running)
    debounced("b.ts");
    await new Promise((r) => setTimeout(r, 15)); // let wave 2's timer fire + append to chain

    await debounced.drain();

    // Both runs finished, in order, and the slow first run was awaited.
    expect(completed).toEqual(["run1", "run2"]);
  });

  it("cancel() does NOT abort an already-running sync; drain() still awaits it", async () => {
    let syncDone = false;
    const callback = async () => {
      await new Promise((r) => setTimeout(r, 30));
      syncDone = true;
    };

    const debounced = debounceSync(callback, 5);
    debounced("a.ts");

    // Let the debounce fire so the sync is mid-flight, THEN cancel + drain
    // (mirrors stop(): cancel timer → close fs → await drain).
    await new Promise((r) => setTimeout(r, 15));
    debounced.cancel();
    expect(syncDone).toBe(false);

    await debounced.drain();
    expect(syncDone).toBe(true);
  });
});
