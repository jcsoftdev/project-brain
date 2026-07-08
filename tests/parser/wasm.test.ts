import { test, expect, spyOn } from "bun:test";
import { Language } from "web-tree-sitter";
import { WasmParser } from "../../src/parser/wasm";
import { PARSER_TEARDOWN_EVERY, MAX_LINE_LENGTH, MAX_PARSE_BYTES } from "../../src/constants";

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

test("oversize gate: a single pathologically long line is rejected even when total bytes are well under MAX_PARSE_BYTES", async () => {
  const p = new WasmParser();
  await p.init();
  await p.warm(".ts");

  // One line exceeding MAX_LINE_LENGTH, but total source size is nowhere
  // near MAX_PARSE_BYTES — this must be caught by the per-line scan, not the
  // whole-source byte-length check.
  const longLine = `const x = "${"a".repeat(MAX_LINE_LENGTH + 10)}";`;
  expect(Buffer.byteLength(longLine, "utf8")).toBeLessThan(MAX_PARSE_BYTES);
  const sourceWithLongLine = `export function ok() {}\n${longLine}\nexport function alsoOk() {}\n`;
  expect(p.parseFile(".ts", sourceWithLongLine)).toBeNull();

  // Same total length distributed across many short lines must NOT be
  // flagged — proves the gate is about per-line length, not total size.
  const manyShortLines = Array.from(
    { length: Math.ceil(longLine.length / 50) },
    (_, i) => `const line${i} = ${i};`
  ).join("\n");
  const ok = p.parseFile(".ts", manyShortLines);
  expect(ok).not.toBeNull();
  ok!.tree.delete();

  // Boundary case: the pathologically long line is the LAST line, with no
  // trailing newline — an off-by-one manual scan could easily forget to
  // check the final (unterminated) line.
  const sourceEndingInLongLine = `export function ok() {}\n${longLine}`;
  expect(p.parseFile(".ts", sourceEndingInLongLine)).toBeNull();

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
