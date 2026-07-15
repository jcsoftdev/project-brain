import { describe, it, expect } from "bun:test";
import { bucketChangedFilesByModule } from "../../src/concept/bucket.js";

describe("bucketChangedFilesByModule", () => {
  it("groups changed files under their top-level module", () => {
    const result = bucketChangedFilesByModule(
      ["src/foo.ts", "src/bar.ts", "tests/foo.test.ts", "README.md"],
      ["src", "tests", "docs"]
    );
    expect(result.get("src")).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(result.get("tests")).toEqual(["tests/foo.test.ts"]);
    expect(result.has("docs")).toBe(false);
  });

  it("returns an empty map when nothing changed under a known module", () => {
    const result = bucketChangedFilesByModule(["README.md"], ["src"]);
    expect(result.size).toBe(0);
  });
});
