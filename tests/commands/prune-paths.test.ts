import { describe, it, expect } from "bun:test";
import { DATA_DIR, DB_PATH } from "../../src/constants.js";

describe("prune path defaults", () => {
  it("reads tables from DB_PATH, which is not the registry's DATA_DIR", () => {
    // These were conflated once: the store was pointed at DATA_DIR, found zero
    // tables, and prune cheerfully reported "Nothing to prune" on a data dir
    // holding 190GB. Unit tests missed it because they inject both paths.
    expect(DB_PATH).not.toBe(DATA_DIR);
    expect(DB_PATH.startsWith(DATA_DIR)).toBe(true);
  });
});
