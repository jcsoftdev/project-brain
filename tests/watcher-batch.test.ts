/**
 * T-9: Watcher dedupe + batch cap (anti-storm)
 *
 * Drives debounceSync with 500 distinct paths + some duplicates.
 * Asserts:
 *   (a) every wave length ≤ WATCHER_MAX_BATCH (200)
 *   (b) the union of all waves == 500 unique paths (no drops)
 *   (c) no path appears twice across waves
 */
import { describe, it, expect } from "bun:test";
import { debounceSync } from "../src/watcher.js";
import { WATCHER_MAX_BATCH } from "../src/constants.js";

describe("T-9: debounceSync dedupe + batch cap", () => {
  it("WATCHER_MAX_BATCH is 200", () => {
    expect(WATCHER_MAX_BATCH).toBe(200);
  });

  it("(a) every wave is ≤ WATCHER_MAX_BATCH paths", async () => {
    const waves: string[][] = [];
    const callback = async (paths: string[]) => {
      waves.push([...paths]);
    };

    const debounced = debounceSync(callback, 30);

    // 500 distinct paths
    for (let i = 0; i < 500; i++) {
      debounced(`file-${i}.ts`);
    }
    // A few duplicates — should be deduped
    debounced("file-0.ts");
    debounced("file-1.ts");
    debounced("file-2.ts");

    await new Promise((r) => setTimeout(r, 150));

    expect(waves.length).toBeGreaterThan(0);
    for (const wave of waves) {
      expect(wave.length).toBeLessThanOrEqual(WATCHER_MAX_BATCH);
    }
  });

  it("(b) union of all waves == 500 unique paths (no drops)", async () => {
    const waves: string[][] = [];
    const callback = async (paths: string[]) => {
      waves.push([...paths]);
    };

    const debounced = debounceSync(callback, 30);

    for (let i = 0; i < 500; i++) {
      debounced(`file-${i}.ts`);
    }
    // Duplicates
    debounced("file-0.ts");
    debounced("file-100.ts");

    await new Promise((r) => setTimeout(r, 150));

    const allPaths = waves.flat();
    expect(allPaths.length).toBe(500);

    const expected = new Set(Array.from({ length: 500 }, (_, i) => `file-${i}.ts`));
    const got = new Set(allPaths);
    expect(got.size).toBe(500);
    for (const p of expected) {
      expect(got.has(p)).toBe(true);
    }
  });

  it("(c) no path appears twice across waves", async () => {
    const waves: string[][] = [];
    const callback = async (paths: string[]) => {
      waves.push([...paths]);
    };

    const debounced = debounceSync(callback, 30);

    for (let i = 0; i < 500; i++) {
      debounced(`file-${i}.ts`);
    }
    debounced("file-0.ts");
    debounced("file-1.ts");

    await new Promise((r) => setTimeout(r, 150));

    const allPaths = waves.flat();
    const seen = new Set<string>();
    for (const p of allPaths) {
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
  });

  it("waves are delivered sequentially (each awaited before next)", async () => {
    const order: number[] = [];
    let waveIndex = 0;

    const callback = async (paths: string[]) => {
      const idx = waveIndex++;
      order.push(idx * 10); // start marker
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      order.push(idx * 10 + 1); // end marker
    };

    const debounced = debounceSync(callback, 30);

    // Push enough paths to guarantee multiple waves
    for (let i = 0; i < 450; i++) {
      debounced(`file-${i}.ts`);
    }

    // Wait for all waves to finish: debounce (30ms) + 3 waves * 10ms async each + buffer
    await new Promise((r) => setTimeout(r, 300));

    // Sequential means: wave 0 ends before wave 1 starts, etc.
    // Pattern must be: 0, 1, 10, 11, 20, 21 (not interleaved)
    expect(order.length).toBeGreaterThan(0);
    for (let i = 0; i < order.length - 1; i++) {
      // Each end marker (odd offset) must come before the next start marker
      if (order[i] % 10 === 1) {
        // This is an end marker; next must be a start marker of the next wave
        if (i + 1 < order.length) {
          expect(order[i + 1] % 10).toBe(0);
        }
      }
    }
  });
});
