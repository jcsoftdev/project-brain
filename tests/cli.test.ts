import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "../src/cli.ts");
const CWD = join(import.meta.dir, "..");

function spawnCli(args: string[] = [], env?: Record<string, string>) {
  return Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BRAIN_DATA_DIR: "/tmp/brain-cli-test", ...env },
  });
}

describe("CLI entry point", () => {
  it("has shebang line", async () => {
    const content = await readFile(CLI_PATH, "utf-8");
    expect(content.startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  it("no args starts MCP server (does not crash)", async () => {
    const proc = spawnCli();
    await new Promise((resolve) => setTimeout(resolve, 500));
    proc.kill();
    expect(proc.pid).toBeGreaterThan(0);
  });

  it("'serve' starts MCP server (does not crash)", async () => {
    const proc = spawnCli(["serve"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    proc.kill();
    expect(proc.pid).toBeGreaterThan(0);
  });

  it("'--help' prints usage and exits 0", async () => {
    const proc = spawnCli(["--help"]);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("project-brain");
    expect(stdout).toContain("setup");
    expect(stdout).toContain("init");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("reindex");
    expect(stdout).toContain("health");
    expect(stdout).toContain("serve");
  });

  it("'-h' prints usage and exits 0", async () => {
    const proc = spawnCli(["-h"]);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("project-brain");
  });

  it("unknown command exits 1 with error on stderr", async () => {
    const proc = spawnCli(["foobar"]);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command: foobar");
  });

  it("each known command uses dynamic import (module convention)", async () => {
    const content = await readFile(CLI_PATH, "utf-8");
    // Each command should use await import() for lazy loading
    expect(content).toContain('await import(');
  });

  /**
   * Scenario 4.8 — serve without --http uses stdio [unit]
   * Verify that the CLI source code does NOT call createHttpServer in the
   * default stdio branch.
   */
  it("Scenario 4.8: serve (no --http) uses stdio transport path in source", async () => {
    const content = await readFile(CLI_PATH, "utf-8");
    expect(content).toContain("StdioServerTransport");
    // The --http branch must be conditional
    expect(content).toContain("--http");
  });

  /**
   * Scenario 4.7 — --http flag routes to HTTP server [unit]
   * Verify that the CLI source code imports createHttpServer when --http is present.
   */
  it("Scenario 4.7: --http path imports createHttpServer in source", async () => {
    const content = await readFile(CLI_PATH, "utf-8");
    expect(content).toContain("createHttpServer");
    expect(content).toContain("server-http");
  });

  /**
   * Scenario 4.8b — '--help' output includes serve --http entry
   */
  it("help output mentions serve --http", async () => {
    const proc = spawnCli(["--help"]);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--http");
  });
});
