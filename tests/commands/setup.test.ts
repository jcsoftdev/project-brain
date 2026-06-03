import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("setup command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setup-cmd-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports execute function", async () => {
    const { execute } = await import("../../src/commands/setup.js");
    expect(typeof execute).toBe("function");
  });

  it("creates data directory", async () => {
    // We need to import the actual implementation
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
    // Directory should exist
    const proc = Bun.spawn(["test", "-d", dataDir], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);
  });

  it("skips gracefully if data dir exists", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");
    await Bun.spawn(["mkdir", "-p", dataDir], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
  });

  it("returns environment info", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.env).toBeDefined();
    expect(result.env.bun).toBe(Bun.version);
    expect(result.env.platform).toBe(process.platform);
  });

  it("is idempotent on re-run", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dataDir = join(tempDir, "data");

    await runSetup({ dataDir, skipOllama: true, skipRegistration: true });
    const result = await runSetup({
      dataDir,
      skipOllama: true,
      skipRegistration: true,
    });

    expect(result.dataDir).toBe(dataDir);
  });
});
