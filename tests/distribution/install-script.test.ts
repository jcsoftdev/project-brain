/**
 * The installer's platform table and the release build matrix are two
 * hand-maintained lists of the same thing. A target added to the matrix but not
 * to the script installs nothing on that platform; a target in the script but
 * not the matrix downloads a 404. Neither shows up in any other test, because
 * both files are "just config".
 *
 * Same anti-drift shape as the skill-manifest parity checks: assert the two
 * lists agree rather than trusting whoever edits one to remember the other.
 */
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");

async function releaseTargets(): Promise<string[]> {
  const yaml = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");
  // `target:` only — `bun_target:` has an underscore before it, not whitespace.
  return [...yaml.matchAll(/^\s+target:\s*([a-z0-9-]+)\s*$/gm)].map((m) => m[1]).sort();
}

async function installScript(): Promise<string> {
  return readFile(join(ROOT, "scripts/install.sh"), "utf8");
}

/** Asset names the script is willing to download. */
function scriptAssets(script: string): string[] {
  return [...script.matchAll(/echo "project-brain-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
}

describe("install.sh ↔ release matrix parity", () => {
  it("the release matrix builds the five expected targets", async () => {
    expect(await releaseTargets()).toEqual([
      "darwin-arm64",
      "linux-arm64",
      "linux-x64",
      "windows-arm64",
      "windows-x64",
    ]);
  });

  it("every asset the script downloads is actually built", async () => {
    const built = new Set(await releaseTargets());
    const wanted = scriptAssets(await installScript());
    expect(wanted.length).toBeGreaterThan(0);
    const phantom = wanted.filter((t) => !built.has(t));
    expect(phantom, `script downloads assets no job builds: ${phantom.join(", ")}`).toEqual([]);
  });

  /**
   * Windows targets are deliberately absent — the script tells the user to use
   * Scoop or npm instead. Every OTHER built target must be reachable, or that
   * platform has a published binary nobody can install this way.
   */
  it("every non-Windows target is reachable from the script", async () => {
    const built = (await releaseTargets()).filter((t) => !t.startsWith("windows-"));
    const wanted = new Set(scriptAssets(await installScript()));
    const unreachable = built.filter((t) => !wanted.has(t));
    expect(unreachable, `built but not installable: ${unreachable.join(", ")}`).toEqual([]);
  });

  /** Intel macOS has no build. Silently handing it an arm64 binary is the bug. */
  it("refuses Intel macOS explicitly instead of downloading the wrong arch", async () => {
    const script = await installScript();
    expect(script).toContain("Intel macOS is not built");
    expect(await releaseTargets()).not.toContain("darwin-x64");
  });

  it("verifies the binary runs before putting it on PATH", async () => {
    const script = await installScript();
    expect(script).toContain("--version");
    expect(script).toMatch(/does not run on this machine/);
  });

  it("cleans up the temp dir on failure, not only on success", async () => {
    const script = await installScript();
    expect(script).toMatch(/trap .*rm -rf.*EXIT/);
  });

  it("is POSIX sh with a strict mode, not bash-only", async () => {
    const script = await installScript();
    expect(script.split("\n")[0]).toBe("#!/bin/sh");
    expect(script).toContain("set -eu");
  });
});
