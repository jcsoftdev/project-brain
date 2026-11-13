import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEmbedLock,
  embedLockPath,
  runWithEmbedLock,
  markEmbedPending,
  drainEmbedPending,
  resolveEmbedLockWaitMs,
  EMBED_LOCK_WAIT_MS,
} from "../../src/commands/embed-lock.js";
import { SYNC_LOCK_STALE_MS } from "../../src/commands/sync-lock.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-embed-lock-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runWithEmbedLock — two concurrent foreground syncs", () => {
  it("runs them one after the other, and the second announces the wait once", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const gate = deferred();
    const run = async (root: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${root}`);
      if (root === "/a") await gate.promise;
      order.push(`end ${root}`);
      active--;
      return 0;
    };
    const waits: unknown[] = [];

    const first = runWithEmbedLock({ dataDir, root: "/a", coalesce: false, run });
    await new Promise((r) => setTimeout(r, 20));
    const second = runWithEmbedLock({
      dataDir,
      root: "/b",
      coalesce: false,
      run,
      pollMs: 5,
      timeoutMs: 5_000,
      onWait: (holder) => waits.push(holder),
    });
    await new Promise((r) => setTimeout(r, 40));
    gate.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe("ran");
    expect(b.kind).toBe("ran");
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start /a", "end /a", "start /b", "end /b"]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ pid: process.pid });
    expect(existsSync(embedLockPath(dataDir))).toBe(false);
  });

  it("gives up after the bounded wait instead of queueing forever", async () => {
    await acquireEmbedLock({ dataDir, pid: 4242, isAlive: () => true });
    let ran = false;

    const outcome = await runWithEmbedLock({
      dataDir,
      root: "/b",
      coalesce: false,
      isAlive: () => true,
      pollMs: 5,
      timeoutMs: 30,
      run: async () => {
        ran = true;
        return 0;
      },
    });

    expect(outcome).toEqual({ kind: "timeout", holder: expect.objectContaining({ pid: 4242 }) });
    expect(ran).toBe(false);
  });
});

describe("runWithEmbedLock — stale lock", () => {
  it("takes over a lock whose holder died, without waiting", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(embedLockPath(dataDir), JSON.stringify({ pid: 999_999, at: Date.now() }));
    let waited = false;

    const outcome = await runWithEmbedLock({
      dataDir,
      root: "/a",
      coalesce: false,
      isAlive: (pid) => pid !== 999_999,
      onWait: () => (waited = true),
      run: async () => {
        expect(JSON.parse(readFileSync(embedLockPath(dataDir), "utf-8")).pid).toBe(process.pid);
        return 0;
      },
    });

    expect(outcome.kind).toBe("ran");
    expect(waited).toBe(false);
  });

  it("takes over a lock past the stale window even when its pid looks alive", async () => {
    writeFileSync(embedLockPath(dataDir), JSON.stringify({ pid: 4242, at: Date.now() - SYNC_LOCK_STALE_MS - 1 }));

    const lock = await acquireEmbedLock({ dataDir, pid: 7, isAlive: () => true });

    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(embedLockPath(dataDir), "utf-8")).pid).toBe(7);
  });

  it("lets exactly one of several contenders take over the same dead holder", async () => {
    writeFileSync(embedLockPath(dataDir), JSON.stringify({ pid: 999_999, at: Date.now() }));
    const isAlive = (pid: number) => pid !== 999_999;

    const results = await Promise.all(
      [11, 12, 13, 14, 15].map((pid) => acquireEmbedLock({ dataDir, pid, isAlive }))
    );

    expect(results.filter((l) => l !== null)).toHaveLength(1);
  });
});

describe("runWithEmbedLock — coalescing hook-triggered runs", () => {
  it("queues a changed-only run behind the holder, which runs it once at the end", async () => {
    const calls: Array<[string, boolean]> = [];
    const gate = deferred();
    const run = async (root: string, changedOnly: boolean) => {
      calls.push([root, changedOnly]);
      if (root === "/a" && calls.length === 1) await gate.promise;
      return 0;
    };

    const holder = runWithEmbedLock({ dataDir, root: "/a", coalesce: true, run });
    await new Promise((r) => setTimeout(r, 20));

    const queued1 = await runWithEmbedLock({ dataDir, root: "/b", coalesce: true, run });
    const queued2 = await runWithEmbedLock({ dataDir, root: "/b", coalesce: true, run });
    const queued3 = await runWithEmbedLock({ dataDir, root: "/a", coalesce: true, run });
    expect(queued1.kind).toBe("queued");
    expect(queued2.kind).toBe("queued");
    expect(queued3.kind).toBe("queued");
    expect(calls).toEqual([["/a", true]]);

    gate.resolve();
    const outcome = await holder;

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    expect(outcome.drained.sort()).toEqual(["/a", "/b"]);
    expect(calls.slice(1).sort()).toEqual([["/a", true], ["/b", true]]);
    expect(await drainEmbedPending(dataDir)).toEqual([]);
    expect(existsSync(embedLockPath(dataDir))).toBe(false);
  });

  it("keeps draining when a pending root fails", async () => {
    await markEmbedPending(dataDir, "/broken");
    await markEmbedPending(dataDir, "/fine");
    const ran: string[] = [];

    const outcome = await runWithEmbedLock({
      dataDir,
      root: "/a",
      coalesce: true,
      run: async (root) => {
        ran.push(root);
        if (root === "/broken") throw new Error("boom");
        return 0;
      },
    });

    expect(outcome).toMatchObject({ kind: "ran", exitCode: 0 });
    expect(ran.sort()).toEqual(["/a", "/broken", "/fine"]);
  });

  it("routes coalesced roots through runPending when the holder is not a sync", async () => {
    await markEmbedPending(dataDir, "/b");
    const pending: string[] = [];

    await runWithEmbedLock({
      dataDir,
      root: "/a",
      coalesce: false,
      run: async () => 0,
      runPending: async (root) => {
        pending.push(root);
        return 0;
      },
    });

    expect(pending).toEqual(["/b"]);
  });
});

describe("resolveEmbedLockWaitMs", () => {
  it("reads BRAIN_EMBED_LOCK_WAIT_MS and falls back on junk", () => {
    expect(resolveEmbedLockWaitMs({ BRAIN_EMBED_LOCK_WAIT_MS: "1000" })).toBe(1000);
    expect(resolveEmbedLockWaitMs({ BRAIN_EMBED_LOCK_WAIT_MS: "0" })).toBe(0);
    expect(resolveEmbedLockWaitMs({ BRAIN_EMBED_LOCK_WAIT_MS: "soon" })).toBe(EMBED_LOCK_WAIT_MS);
    expect(resolveEmbedLockWaitMs({})).toBe(EMBED_LOCK_WAIT_MS);
  });
});
