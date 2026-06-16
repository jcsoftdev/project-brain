import { test, expect } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";

test("parseFile returns a tree for known ext, null for unknown/oversized", async () => {
  const p = new WasmParser();
  await p.init();
  await p.warm(".ts");
  const ok = p.parseFile(".ts", "export function add(a:number,b:number){return a+b;}");
  expect(ok).not.toBeNull();
  ok!.tree.delete();
  expect(p.parseFile(".unknownext", "whatever")).toBeNull();
  expect(p.parseFile(".ts", "x".repeat(600 * 1024))).toBeNull(); // oversize gate
  p.dispose();
});
