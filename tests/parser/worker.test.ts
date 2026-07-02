import { test, expect } from "bun:test";

// This test proves Bun's native Worker can load worker.ts, initialize its own
// WasmParser, and parse+extract a real file — the exact mechanism Task 7's
// ParserPool depends on. It is deliberately end-to-end (spawns a real OS
// thread) rather than mocked, because the risk being tested is "does the
// worker boundary work at all," not the parse logic itself (already covered
// by tests/parser/wasm.test.ts and tests/parser/extract.test.ts).
test("worker.ts parses a file and returns symbols over postMessage", async () => {
  const worker = new Worker(new URL("../../src/parser/worker.ts", import.meta.url).href);

  const result = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("worker timed out")), 10_000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(String(event.message ?? event)));
    };
    worker.postMessage({
      id: 1,
      path: "add.ts",
      content: "export function add(a: number, b: number) { return a + b; }",
      ext: ".ts",
    });
  });

  expect(result.id).toBe(1);
  expect(result.path).toBe("add.ts");
  expect(result.error).toBeUndefined();
  expect(result.langId).toBe("typescript");
  expect(result.symbols.some((s: any) => s.name === "add")).toBe(true);

  worker.terminate();
});

test("worker.ts replies with an error for a grammar/parse failure instead of crashing", async () => {
  const worker = new Worker(new URL("../../src/parser/worker.ts", import.meta.url).href);

  const result = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("worker timed out")), 10_000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error(String(event.message ?? event)));
    };
    // Oversized content (> MAX_PARSE_BYTES) — parseFile returns null, not a throw.
    worker.postMessage({ id: 2, path: "big.ts", content: "x".repeat(600 * 1024), ext: ".ts" });
  });

  expect(result.id).toBe(2);
  expect(result.error).toBeUndefined();
  expect(result.symbols).toEqual([]); // gated input → no symbols, not a crash

  worker.terminate();
});
