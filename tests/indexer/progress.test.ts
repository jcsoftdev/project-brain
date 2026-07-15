import { describe, it, expect } from "bun:test";
import { formatDuration } from "../../src/indexer/progress.js";

describe("formatDuration", () => {
  it("formats 0ms as 0.0s", () => {
    expect(formatDuration(0)).toBe("0.0s");
  });

  it("formats sub-10s durations with one decimal", () => {
    expect(formatDuration(8300)).toBe("8.3s");
  });

  it("formats 10s-59s durations as whole seconds (floor, no decimal)", () => {
    // Design choice: >=10s drops the decimal for readability. 59999ms floors
    // to 59s rather than rounding up to the (invalid-looking) "60s" — the
    // m/s form only kicks in at the 60000ms boundary itself.
    expect(formatDuration(59999)).toBe("59s");
    expect(formatDuration(42000)).toBe("42s");
  });

  it("formats 60s+ durations as Nm Ss", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(102000)).toBe("1m 42s");
    expect(formatDuration(725000)).toBe("12m 5s");
  });
});
