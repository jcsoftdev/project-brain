import { test, expect } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";
import { extract } from "../../src/parser/extract";

test("extract finds functions and their calls (TS)", async () => {
  const p = new WasmParser(); await p.init(); await p.warm(".ts");
  const src = `function helper(){ return 1; }\nexport function main(){ return helper(); }`;
  const pt = p.parseFile(".ts", src)!;
  try {
    const syms = extract(pt.tree, pt.langId, src);
    const names = syms.map(s => s.name).sort();
    expect(names).toEqual(["helper", "main"]);
    const main = syms.find(s => s.name === "main")!;
    expect(main.edges.map(e => e.dst_name)).toContain("helper");
  } finally { pt.tree.delete(); p.dispose(); }
});
