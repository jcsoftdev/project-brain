import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, openSync, writeSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capLogFile,
  findOversizedOllamaLog,
  formatOllamaLogHint,
  INTERACTIVE_LOG_FILE,
} from "../../src/setup/log-cap.js";
import { execute as skillUsage } from "../../src/commands/skill-usage.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-log-cap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("capLogFile", () => {
  it("leaves a log under the cap alone", async () => {
    const log = join(dir, "x.log");
    writeFileSync(log, "small\n");

    expect(await capLogFile(log, 100)).toEqual({ trimmed: false, bytes: 6 });
    expect(readFileSync(log, "utf-8")).toBe("small\n");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("is a no-op for a missing log", async () => {
    expect(await capLogFile(join(dir, "missing.log"), 100)).toEqual({ trimmed: false, bytes: 0 });
  });

  it("keeps the newest bytes as .1 and truncates the live file in place", async () => {
    const log = join(dir, "x.log");
    writeFileSync(log, "old-old-old-" + "0123456789");
    // The service manager's handle, opened in append mode before the trim.
    const fd = openSync(log, "a");

    const result = await capLogFile(log, 10);
    writeSync(fd, "new\n");
    closeSync(fd);

    expect(result).toEqual({ trimmed: true, bytes: 22 });
    expect(readFileSync(`${log}.1`, "utf-8")).toBe("0123456789");
    // Appends after the trim land at the start, not past a sparse hole.
    expect(readFileSync(log, "utf-8")).toBe("new\n");
  });

  it("replaces the previous rotation instead of keeping more than one", async () => {
    const log = join(dir, "x.log");
    writeFileSync(`${log}.1`, "ancient");
    writeFileSync(log, "abcdefghijkl");

    await capLogFile(log, 4);

    expect(readFileSync(`${log}.1`, "utf-8")).toBe("ijkl");
    expect(statSync(log).size).toBe(0);
  });
});

describe("findOversizedOllamaLog / formatOllamaLogHint", () => {
  it("reports the first log over the threshold and nothing under it", async () => {
    const small = join(dir, "small.log");
    const big = join(dir, "big.log");
    writeFileSync(small, "x".repeat(10));
    writeFileSync(big, "x".repeat(50));

    expect(await findOversizedOllamaLog([join(dir, "none.log"), small], 20)).toBeNull();
    expect(await findOversizedOllamaLog([small, big], 20)).toEqual({ path: big, bytes: 50 });
  });

  it("names the exact trim command, quoting paths that need it", () => {
    expect(formatOllamaLogHint({ path: "/opt/homebrew/var/log/ollama.log", bytes: 1.6 * 1024 ** 3 })).toBe(
      "⚠ Ollama's log is 1.6 GB (/opt/homebrew/var/log/ollama.log) — trim it in place with: : > /opt/homebrew/var/log/ollama.log"
    );
    expect(formatOllamaLogHint({ path: "/tmp/my logs/ollama.log", bytes: 600 * 1024 ** 2 })).toBe(
      "⚠ Ollama's log is 600 MB (/tmp/my logs/ollama.log) — trim it in place with: : > '/tmp/my logs/ollama.log'"
    );
  });
});

describe("skill-usage --write", () => {
  it("caps the interactive Ollama's log on the recurring refresh", async () => {
    const projectsRoot = join(dir, "projects");
    mkdirSync(projectsRoot);
    const log = join(dir, INTERACTIVE_LOG_FILE);
    writeFileSync(log, Buffer.alloc(51 * 1024 ** 2, 120));

    await skillUsage(["--write", "--if-stale"], { dataDir: dir, projectsRoot, log: () => {} });

    expect(statSync(log).size).toBe(0);
    expect(statSync(`${log}.1`).size).toBe(50 * 1024 ** 2);
  });
});
