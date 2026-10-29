import { test, expect } from "bun:test";
import { getSharedWasmParser } from "../../src/parser/wasm";

const SRC = "export function add(a: number, b: number) { return a + b; }\nexport class C { m() { return 1; } }\n";

test("getSharedWasmParser returns one instance across sequential and concurrent calls", async () => {
  const [a, b] = await Promise.all([getSharedWasmParser(), getSharedWasmParser()]);
  expect(a).toBe(b);
  expect(await getSharedWasmParser()).toBe(a);
});

test("repeated use of the shared parser does not grow RSS (per-sync leak guard)", async () => {
  const rss: number[] = [];
  for (let i = 0; i < 25; i++) {
    const p = await getSharedWasmParser();
    await p.warm(".ts");
    p.parseFile(".ts", SRC)?.tree.delete();
    Bun.gc(true);
    rss.push(process.memoryUsage().rss);
  }
  const growthMb = (rss[24] - rss[4]) / 1024 / 1024;
  expect(growthMb).toBeLessThan(40);
}, 30_000);
