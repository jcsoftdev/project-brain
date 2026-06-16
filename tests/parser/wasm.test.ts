import { test, expect } from "bun:test";
import { WasmParser } from "../../src/parser/wasm";
import { PARSER_TEARDOWN_EVERY } from "../../src/constants";

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

test("parser recreates correctly after teardown boundary", async () => {
  const p = new WasmParser();
  await p.init();
  await p.warm(".ts");
  const total = PARSER_TEARDOWN_EVERY + 2;
  for (let i = 0; i < total; i++) {
    const result = p.parseFile(".ts", "const a=1;");
    if (result) result.tree.delete();
  }
  // After the teardown boundary the parser is recreated; this parse must succeed
  const afterBoundary = p.parseFile(".ts", "const a=1;");
  expect(afterBoundary).not.toBeNull();
  if (afterBoundary) afterBoundary.tree.delete();
  p.dispose();
});
