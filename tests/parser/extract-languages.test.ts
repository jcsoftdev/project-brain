import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";
import { extract } from "../../src/parser/extract";

const p = new WasmParser();
beforeAll(async () => { await p.init(); });
afterAll(() => { p.dispose(); });

async function symbolsOf(ext: string, src: string) {
  await p.warm(ext);
  const pt = p.parseFile(ext, src);
  expect(pt, `grammar for ${ext} must load and parse`).not.toBeNull();
  try { return extract(pt!.tree, pt!.langId, src); } finally { pt!.tree.delete(); }
}

it("java: class + method + call edge", async () => {
  const syms = await symbolsOf(".java", `class A { void run() { helper(); } void helper() {} }`);
  const names = syms.map((s) => s.name);
  expect(names).toContain("A");
  expect(names).toContain("run");
  const run = syms.find((s) => s.name === "run")!;
  expect(run.edges.map((e) => e.dst_name)).toContain("helper");
});

it("c: function + call edge", async () => {
  const syms = await symbolsOf(".c", `int helper() { return 1; }\nint main() { return helper(); }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["helper", "main"]));
  expect(syms.find((s) => s.name === "main")!.edges.map((e) => e.dst_name)).toContain("helper");
});

it("cpp: class + function + call edge", async () => {
  const syms = await symbolsOf(".cpp", `class W {};\nint helper() { return 1; }\nint main() { return helper(); }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["W", "helper", "main"]));
});

it("c_sharp: class + method + call edge", async () => {
  const syms = await symbolsOf(".cs", `class A { void Run() { Helper(); } void Helper() {} }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "Run", "Helper"]));
  expect(syms.find((s) => s.name === "Run")!.edges.map((e) => e.dst_name)).toContain("Helper");
});
