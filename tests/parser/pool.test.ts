import { test, expect } from "bun:test";
import { ParserPool, POOL_MIN_FILES } from "../../src/parser/pool.js";

test("POOL_MIN_FILES is a positive threshold", () => {
  expect(POOL_MIN_FILES).toBeGreaterThan(0);
});

test("ParserPool.parseOne parses a single file and returns its symbols", async () => {
  const pool = new ParserPool(2);
  try {
    const result = await pool.parseOne({
      path: "add.ts",
      content: "export function add(a: number, b: number) { return a + b; }",
      ext: ".ts",
    });
    expect(result.error).toBeUndefined();
    expect(result.langId).toBe("typescript");
    expect(result.symbols.some((s) => s.name === "add")).toBe(true);
  } finally {
    pool.dispose();
  }
});

test("ParserPool.parseMany processes more jobs than the pool size, all complete correctly", async () => {
  const pool = new ParserPool(2);
  try {
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      path: `file${i}.ts`,
      content: `export function fn${i}() { return ${i}; }`,
      ext: ".ts",
    }));
    const results = await pool.parseMany(jobs);
    expect(results.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(results[i].path).toBe(`file${i}.ts`);
      expect(results[i].symbols.some((s) => s.name === `fn${i}`)).toBe(true);
    }
  } finally {
    pool.dispose();
  }
});

test("ParserPool.parseMany output matches sequential WasmParser output (parity)", async () => {
  const { WasmParser } = await import("../../src/parser/wasm.js");
  const { extract } = await import("../../src/parser/extract.js");

  const files = [
    { path: "a.ts", content: "export function a() { return b(); }", ext: ".ts" },
    { path: "b.ts", content: "export function b() { return 1; }", ext: ".ts" },
  ];

  // Sequential (existing) path
  const sequential = new WasmParser();
  await sequential.init();
  const sequentialResults: Array<{ path: string; names: string[] }> = [];
  for (const f of files) {
    await sequential.warm(f.ext);
    const pt = sequential.parseFile(f.ext, f.content)!;
    const symbols = extract(pt.tree, pt.langId, f.content);
    pt.tree.delete();
    sequentialResults.push({ path: f.path, names: symbols.map((s) => s.name).sort() });
  }
  sequential.dispose();

  // Pool path
  const pool = new ParserPool(2);
  const poolResults = await pool.parseMany(files);
  pool.dispose();

  for (let i = 0; i < files.length; i++) {
    expect(poolResults[i].symbols.map((s) => s.name).sort()).toEqual(sequentialResults[i].names);
  }
});

test("ParserPool never spawns more workers than its configured size", async () => {
  const pool = new ParserPool(3);
  try {
    // Internal invariant check via the pool's own worker count, not timing.
    expect((pool as any).workers.length).toBe(3);
  } finally {
    pool.dispose();
  }
});
