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

test("worker.ts replies with empty symbols for gated/oversized input instead of crashing", async () => {
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

test("worker.ts replies with a ParseFailure for a genuine thrown exception, and stays usable afterward", async () => {
  const worker = new Worker(new URL("../../src/parser/worker.ts", import.meta.url).href);

  function send(request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker timed out")), 10_000);
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(String(event.message ?? event)));
      };
      worker.postMessage(request);
    });
  }

  // `content: null` reaches WasmParser.oversize()'s `Buffer.byteLength(source, "utf8")`
  // before any WASM/grammar logic runs, throwing a real TypeError ("The \"string\"
  // argument must be of type string..."). This exercises the worker's top-level
  // try/catch → ParseFailure path with an actual thrown exception, not the
  // oversize-gate `parseFile() -> null` success path covered by the previous test.
  const failure = await send({ id: 3, path: "bad.ts", content: null as any, ext: ".ts" });

  expect(failure.id).toBe(3);
  expect(failure.path).toBe("bad.ts");
  expect(typeof failure.error).toBe("string");
  expect(failure.error.length).toBeGreaterThan(0);
  expect(failure.symbols).toBeUndefined();
  expect(failure.langId).toBeUndefined();

  // The worker must not crash/die on the unhandled exception — the same instance
  // should still correctly handle a subsequent, valid request (proves it's still
  // alive and its state, e.g. warmedExts, wasn't corrupted).
  const success = await send({
    id: 4,
    path: "add.ts",
    content: "export function add(a: number, b: number) { return a + b; }",
    ext: ".ts",
  });

  expect(success.id).toBe(4);
  expect(success.error).toBeUndefined();
  expect(success.langId).toBe("typescript");
  expect(success.symbols.some((s: any) => s.name === "add")).toBe(true);

  worker.terminate();
});
