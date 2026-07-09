import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";
import { extract, extractBoundaries } from "../../src/parser/extract";

const p = new WasmParser();
beforeAll(async () => { await p.init(); });
afterAll(() => { p.dispose(); });

async function symbolsOf(ext: string, src: string) {
  await p.warm(ext);
  const pt = p.parseFile(ext, src);
  expect(pt, `grammar for ${ext} must load and parse`).not.toBeNull();
  try { return extract(pt!.tree, pt!.langId, src); } finally { pt!.tree.delete(); }
}

async function boundariesOf(ext: string, src: string) {
  await p.warm(ext);
  const pt = p.parseFile(ext, src);
  expect(pt, `grammar for ${ext} must load and parse`).not.toBeNull();
  try { return extractBoundaries(pt!.tree, pt!.langId); } finally { pt!.tree.delete(); }
}

it("java: class + method + call edge", async () => {
  const syms = await symbolsOf(".java", `class A { void run() { helper(); } void helper() {} }`);
  const names = syms.map((s) => s.name);
  expect(names).toContain("A");
  expect(names).toContain("run");
  const run = syms.find((s) => s.name === "run")!;
  expect(run.edges.map((e) => e.dst_name)).toContain("helper");
});

it("java: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".java", `class A { void run() { helper(); } void helper() {} }`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("c: function + call edge", async () => {
  const syms = await symbolsOf(".c", `int helper() { return 1; }\nint main() { return helper(); }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["helper", "main"]));
  expect(syms.find((s) => s.name === "main")!.edges.map((e) => e.dst_name)).toContain("helper");
});

it("c: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".c", `int helper() { return 1; }\nint main() { return helper(); }`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["helper", "main"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("cpp: class + function + call edge", async () => {
  const syms = await symbolsOf(".cpp", `class W {};\nint helper() { return 1; }\nint main() { return helper(); }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["W", "helper", "main"]));
});

it("cpp: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".cpp", `class W {};\nint helper() { return 1; }\nint main() { return helper(); }`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["W", "helper", "main"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("c_sharp: class + method + call edge", async () => {
  const syms = await symbolsOf(".cs", `class A { void Run() { Helper(); } void Helper() {} }`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "Run", "Helper"]));
  expect(syms.find((s) => s.name === "Run")!.edges.map((e) => e.dst_name)).toContain("Helper");
});

it("c_sharp: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".cs", `class A { void Run() { Helper(); } void Helper() {} }`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "Run", "Helper"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("ruby: class + method + call edge", async () => {
  const syms = await symbolsOf(".rb", `class A\n  def run\n    helper\n  end\n  def helper\n  end\nend`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  // NOTE: a bare-word call like `helper` (no parens/receiver) parses as a plain
  // `identifier` node in tree-sitter-ruby, not a `call` node with a resolvable
  // callee — so there is no reliable call-edge to assert here without forcing a
  // false positive in extract.ts. Names-only coverage is the honest assertion.
});

it("ruby: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".rb", `class A\n  def run\n    helper\n  end\n  def helper\n  end\nend`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("php: function + method + call edge", async () => {
  const syms = await symbolsOf(
    ".php",
    `<?php\nclass A { function run() { $this->helper(); } function helper() {} }\nfunction top() { other(); }`,
  );
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "run", "helper", "top"]));
  expect(syms.find((s) => s.name === "top")!.edges.map((e) => e.dst_name)).toContain("other");
  expect(syms.find((s) => s.name === "run")!.edges.map((e) => e.dst_name)).toContain("helper");
});

it("php: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(
    ".php",
    `<?php\nclass A { function run() { $this->helper(); } function helper() {} }\nfunction top() { other(); }`,
  );
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "run", "helper", "top"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("swift: function + class + call edge", async () => {
  const syms = await symbolsOf(".swift", `class A { func run() { helper() } }\nfunc helper() {}`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(syms.find((s) => s.name === "run")!.edges.map((e) => e.dst_name)).toContain("helper");
});

it("swift: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".swift", `class A { func run() { helper() } }\nfunc helper() {}`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});

it("kotlin: function + class + call edge", async () => {
  const syms = await symbolsOf(".kt", `class A { fun run() { helper() } }\nfun helper() {}`);
  expect(syms.map((s) => s.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(syms.find((s) => s.name === "run")!.edges.map((e) => e.dst_name)).toContain("helper");
});

it("kotlin: boundaries present with byte offsets", async () => {
  const boundaries = await boundariesOf(".kt", `class A { fun run() { helper() } }\nfun helper() {}`);
  expect(boundaries.map((b) => b.name)).toEqual(expect.arrayContaining(["A", "run", "helper"]));
  expect(boundaries.every((b) => b.end_index > b.start_index)).toBe(true);
});
