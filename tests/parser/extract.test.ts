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

test("nested symbol calls are not attributed to the enclosing symbol", async () => {
  const p = new WasmParser(); await p.init(); await p.warm(".ts");
  const src = `class Foo { bar(){ return baz(); } }\nfunction baz(){ return 1; }`;
  const pt = p.parseFile(".ts", src)!;
  try {
    const syms = extract(pt.tree, pt.langId, src);
    const bar = syms.find(s => s.name === "bar")!;
    const foo = syms.find(s => s.name === "Foo")!;
    expect(bar.edges.map(e => e.dst_name)).toContain("baz");
    expect(foo.edges.map(e => e.dst_name)).not.toContain("baz");
  } finally { pt.tree.delete(); p.dispose(); }
});

test("extracts a Python function and its call", async () => {
  const p = new WasmParser(); await p.init(); await p.warm(".py");
  const src = `def helper():\n    return 1\n\ndef main():\n    return helper()\n`;
  const pt = p.parseFile(".py", src)!;
  try {
    const syms = extract(pt.tree, pt.langId, src);
    expect(syms.map(s => s.name).sort()).toEqual(["helper", "main"]);
    const main = syms.find(s => s.name === "main")!;
    expect(main.edges.map(e => e.dst_name)).toContain("helper");
  } finally { pt.tree.delete(); p.dispose(); }
});
