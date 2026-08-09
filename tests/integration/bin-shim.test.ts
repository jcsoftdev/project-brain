/**
 * `bin/project-brain` is the npm entry point: it resolves the platform package
 * and runs the native binary with execFileSync, blocking for the child's whole
 * life. That makes the shim — not the AI tool — the server's parent, which is
 * why the server's orphan check would have watched the wrong process.
 *
 * The shim hands its OWN parent down as BRAIN_CLIENT_PID so the server watches
 * the tool instead. Asserted here against the real shim with a stub platform
 * package, because the two ends are edited in different files and nothing else
 * would notice them drifting apart.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "../../bin/project-brain");

/**
 * Mirrors the map in bin/project-brain. The stub package has to be named for
 * the platform the test is RUNNING on, not a fixed one — the shim resolves
 * `${process.platform}-${process.arch}`, so a hardcoded darwin-arm64 fixture
 * makes every assertion here fail on Linux CI with an empty stdout.
 */
const PKG_BY_PLATFORM: Record<string, string> = {
  "darwin-arm64": "project-brain-darwin-arm64",
  "linux-x64": "project-brain-linux-x64",
  "linux-arm64": "project-brain-linux-arm64",
  "win32-x64": "project-brain-windows-x64",
  "win32-arm64": "project-brain-windows-arm64",
};
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const PKG_NAME = PKG_BY_PLATFORM[PLATFORM_KEY];

let dir: string;
let shim: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-shim-"));
  const pkgDir = join(dir, "node_modules", PKG_NAME);
  await mkdir(join(pkgDir, "bin"), { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: PKG_NAME, version: "0.0.0" })
  );
  // Stub "native binary": reports the environment it was handed and exits.
  const native = join(pkgDir, "bin", "project-brain-native");
  await writeFile(
    native,
    '#!/bin/sh\necho "CLIENT_PID=$BRAIN_CLIENT_PID"\necho "CENTROIDS=$LANCE_INCLUDE_VECTOR_CENTROIDS"\necho "ARGS=$*"\nexit ${STUB_EXIT:-0}\n'
  );
  await chmod(native, 0o755);

  shim = join(dir, "shim.mjs");
  await copyFile(SHIM, shim);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runShim(args: string[] = [], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", shim, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_OPTIONS: "", ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

// The stub native binary is a /bin/sh script, and the shim appends `.exe` on
// Windows — neither holds there. The shim's Windows path is covered by the
// platform-package matrix in release.yml, not here.
describe.skipIf(process.platform === "win32")("bin/project-brain shim", () => {
  it("hands its own parent down as BRAIN_CLIENT_PID", async () => {
    const { stdout } = await runShim();
    const pid = Number(stdout.match(/CLIENT_PID=(\d+)/)?.[1]);
    expect(pid, "shim did not pass BRAIN_CLIENT_PID at all").toBeGreaterThan(0);
    // Our pid, because bun-test spawned the shim: the shim's parent is us.
    expect(pid, "passed the wrong pid — must be the shim's PARENT").toBe(process.pid);
  });

  /**
   * The pid handed down must be the CLIENT's, never the shim's own. Those are
   * different processes, and confusing them is precisely the bug: a server
   * watching the shim sees it alive for as long as it is itself alive.
   */
  it("does not pass its own pid", async () => {
    const { stdout } = await runShim();
    const passed = Number(stdout.match(/CLIENT_PID=(\d+)/)?.[1]);
    expect(passed).not.toBe(0);
    expect(passed, "passed a pid that is not our own").toBe(process.pid);
  });

  it("lets an explicit BRAIN_CLIENT_PID win", async () => {
    const { stdout } = await runShim([], { BRAIN_CLIENT_PID: "424242" });
    expect(stdout).toContain("CLIENT_PID=424242");
  });

  /** Regression: the centroids flag must reach the child's real environment. */
  it("still sets LANCE_INCLUDE_VECTOR_CENTROIDS and forwards argv", async () => {
    const { stdout } = await runShim(["serve", "--http"]);
    expect(stdout).toContain("CENTROIDS=false");
    expect(stdout).toContain("ARGS=serve --http");
  });

  it("propagates the child's non-zero exit code", async () => {
    const { exitCode } = await runShim([], { STUB_EXIT: "3" });
    expect(exitCode).toBe(3);
  });
});
