import { test, expect, spyOn } from "bun:test";
import { Language } from "web-tree-sitter";
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

test("warm does not throw on unknown ext and leaves the parser usable for a good ext", async () => {
  const p = new WasmParser();
  await p.init();

  // Unknown ext → no spec → must be a silent no-op, never a throw.
  await expect(p.warm(".totallybogusext")).resolves.toBeUndefined();

  // Parser is still usable for a real language afterward.
  await p.warm(".ts");
  const ok = p.parseFile(".ts", "export function add(a:number,b:number){return a+b;}");
  expect(ok).not.toBeNull();
  ok!.tree.delete();
  p.dispose();
});

test("warm swallows a grammar load failure and keeps the parser usable", async () => {
  const p = new WasmParser();
  await p.init();

  // Force the real Language.load (invoked inside ensureGrammar) to reject ONCE,
  // exercising the .catch evictor in the fix. warm() must swallow the rejection.
  const grammars = (p as any).grammars as Map<string, Promise<any>>;
  const loadSpy = spyOn(Language, "load").mockRejectedValueOnce(
    new Error("forced load failure")
  );

  await expect(p.warm(".ts")).resolves.toBeUndefined();

  // Rejected promise was evicted from the cache (not permanently poisoned),
  // so a retry can re-attempt the load instead of re-using the failed promise.
  expect(grammars.has("typescript")).toBe(false);

  // Restore the real loader and confirm the parser is still usable afterward.
  loadSpy.mockRestore();
  await p.warm(".ts");
  const ok = p.parseFile(".ts", "const a = 1;");
  expect(ok).not.toBeNull();
  if (ok) ok.tree.delete();
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
