import { describe, expect, it } from "bun:test";
import { mapLimit } from "../../src/indexer/concurrency.js";

describe("mapLimit", () => {
  it("never exceeds the concurrency limit and preserves order", async () => {
    let active = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
