import { test, expect, describe } from "bun:test";
import { runUpdateCheck } from "../src/commands/update-check.js";

describe("runUpdateCheck", () => {
  test("writes cache with the fetched latest version", async () => {
    let written: { checkedAt: number; latest: string } | null = null;
    await runUpdateCheck({
      fetchLatest: async () => "0.9.3",
      writeCache: (c) => { written = c; },
      now: () => 12345,
    });
    expect(written).not.toBeNull();
    expect(written!.latest).toBe("0.9.3");
    expect(written!.checkedAt).toBe(12345);
  });

  test("fail-silent: a fetch error writes nothing and does not throw", async () => {
    let written = false;
    await runUpdateCheck({
      fetchLatest: async () => { throw new Error("network down"); },
      writeCache: () => { written = true; },
      now: () => 1,
    });
    expect(written).toBe(false);
  });

  test("fail-silent: a null/empty version writes nothing", async () => {
    let written = false;
    await runUpdateCheck({
      fetchLatest: async () => null,
      writeCache: () => { written = true; },
      now: () => 1,
    });
    expect(written).toBe(false);
  });
});
