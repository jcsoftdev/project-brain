import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLastError, readLastError, clearLastError } from "../../src/store/error-state.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-errstate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("last error state", () => {
  it("returns null when absent", async () => {
    expect(await readLastError(dir, "proj")).toBeNull();
  });

  it("round-trips phase + message + timestamp", async () => {
    await writeLastError(dir, "proj", "search", new Error("ollama down"));
    const result = await readLastError(dir, "proj");
    expect(result?.phase).toBe("search");
    expect(result?.message).toBe("ollama down");
    expect(typeof result?.timestamp).toBe("number");
  });

  it("stringifies non-Error values", async () => {
    await writeLastError(dir, "proj", "sync-parser-init", "plain string failure");
    const result = await readLastError(dir, "proj");
    expect(result?.message).toBe("plain string failure");
  });

  it("truncates messages longer than 500 chars", async () => {
    await writeLastError(dir, "proj", "search", new Error("x".repeat(600)));
    const result = await readLastError(dir, "proj");
    expect(result?.message.length).toBe(500);
  });

  it("clearLastError removes the entry when the phase matches", async () => {
    await writeLastError(dir, "proj", "search", new Error("boom"));
    await clearLastError(dir, "proj", "search");
    expect(await readLastError(dir, "proj")).toBeNull();
  });

  it("clearLastError leaves a DIFFERENT phase's error untouched", async () => {
    await writeLastError(dir, "proj", "sync-parser-init", new Error("wasm load failed"));
    await clearLastError(dir, "proj", "search"); // unrelated phase succeeding
    const result = await readLastError(dir, "proj");
    expect(result?.phase).toBe("sync-parser-init");
    expect(result?.message).toBe("wasm load failed");
  });

  it("clearLastError is a no-op when nothing is stored", async () => {
    await expect(clearLastError(dir, "proj", "search")).resolves.toBeUndefined();
  });

  it("writeLastError never throws even when the underlying write fails", async () => {
    const writeSpy = spyOn(Bun, "write").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      await expect(writeLastError(dir, "proj", "search", new Error("x"))).resolves.toBeUndefined();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("readLastError returns null (not throw) on corrupt JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "proj.error.json"), "{not valid json");
    expect(await readLastError(dir, "proj")).toBeNull();
  });

  it("different projects stay isolated", async () => {
    await writeLastError(dir, "proj-a", "search", new Error("a failed"));
    await writeLastError(dir, "proj-b", "search", new Error("b failed"));
    expect((await readLastError(dir, "proj-a"))?.message).toBe("a failed");
    expect((await readLastError(dir, "proj-b"))?.message).toBe("b failed");
  });
});
