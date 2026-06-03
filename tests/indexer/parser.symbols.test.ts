import { describe, expect, it } from "bun:test";
import { chunkContent } from "../../src/indexer/parser.js";

describe("symbol capture", () => {
  it("captures function name + signature + line range", () => {
    const src = "export function handleSearch(args, deps) {\n  return 1;\n}\n";
    const chunks = chunkContent(src, "s.ts", "src");
    const c = chunks.find((x) => x.symbol_name === "handleSearch");
    expect(c).toBeTruthy();
    expect(c!.signature).toContain("handleSearch(args, deps)");
    expect(c!.start_line).toBe(1);
  });

  it("does not split on a brace inside a string literal", () => {
    const src = 'function a() {\n  const s = "}{";\n  return s;\n}\nfunction b() { return 2; }\n';
    const chunks = chunkContent(src, "s.ts", "src");
    expect(chunks.filter((c) => c.symbol_name === "a")).toHaveLength(1);
    expect(chunks.some((c) => c.symbol_name === "b")).toBe(true);
  });
});
