import { test, expect } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";
import { extractBoundaries } from "../../src/parser/extract";

test("extractBoundaries finds top-level declarations with byte offsets", async () => {
  const p = new WasmParser(); await p.init(); await p.warm(".ts");
  const src = `function helper(){ return 1; }\nexport function main(){ return helper(); }`;
  const pt = p.parseFile(".ts", src)!;
  try {
    const boundaries = extractBoundaries(pt.tree, pt.langId);
    const names = boundaries.map((b) => b.name).sort();
    expect(names).toEqual(["helper", "main"]);
    const helper = boundaries.find((b) => b.name === "helper")!;
    expect(helper.start_index).toBe(0);
    expect(helper.end_index).toBe(src.indexOf("}") + 1);
    expect(helper.kind).toBe("function");
    expect(helper.start_line).toBe(1);
    expect(helper.end_line).toBe(1);
    expect(helper.depth).toBe(0);
  } finally { pt.tree.delete(); p.dispose(); }
});

test("extractBoundaries captures nested declarations with increasing depth", async () => {
  const p = new WasmParser(); await p.init(); await p.warm(".ts");
  const src = `class Foo {\n  bar() { return 1; }\n}`;
  const pt = p.parseFile(".ts", src)!;
  try {
    const boundaries = extractBoundaries(pt.tree, pt.langId);
    const foo = boundaries.find((b) => b.name === "Foo")!;
    const bar = boundaries.find((b) => b.name === "bar")!;
    expect(foo.depth).toBe(0);
    expect(bar.depth).toBe(1);
    // Nested boundary's byte range must be fully contained within its parent's.
    expect(bar.start_index).toBeGreaterThanOrEqual(foo.start_index);
    expect(bar.end_index).toBeLessThanOrEqual(foo.end_index);
  } finally { pt.tree.delete(); p.dispose(); }
});
