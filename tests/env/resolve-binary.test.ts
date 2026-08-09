/**
 * Tool detection used to be a bare `Bun.which(name)`. That misses every CLI
 * installed by a vendor's own shell installer, because those drop the binary in
 * ~/.local/bin and put the PATH export in ~/.profile — which zsh never reads.
 * Claude Code's native installer does exactly this, so project-brain reported
 * "Claude Code: not installed" on a machine where it was installed and running.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary } from "../../src/env/resolve-binary.js";

let home: string;

/** Creates an executable file at <home>/<relative path> and returns its path. */
async function makeExecutable(...segments: string[]): Promise<string> {
  const full = join(home, ...segments);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "#!/bin/sh\nexit 0\n");
  await chmod(full, 0o755);
  return full;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pb-which-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("resolveBinary", () => {
  it("prefers what is on PATH", async () => {
    const onPath = "/somewhere/on/path/claude";
    const found = await resolveBinary("claude", {
      home,
      which: () => onPath,
      systemDirs: [],
    });
    expect(found).toBe(onPath);
  });

  /** The regression this module exists for. */
  it("finds a binary in ~/.local/bin when PATH does not have it", async () => {
    const expected = await makeExecutable(".local", "bin", "claude");
    const found = await resolveBinary("claude", { home, which: () => null, systemDirs: [] });
    expect(found).toBe(expected);
  });

  it("finds Claude Code's older ~/.claude/local location", async () => {
    const expected = await makeExecutable(".claude", "local", "claude");
    const found = await resolveBinary("claude", { home, which: () => null, systemDirs: [] });
    expect(found).toBe(expected);
  });

  it("finds a binary under the tool's own dot-directory", async () => {
    const expected = await makeExecutable(".codex", "bin", "codex");
    const found = await resolveBinary("codex", { home, which: () => null, systemDirs: [] });
    expect(found).toBe(expected);
  });

  it("returns null when the tool is genuinely absent", async () => {
    const found = await resolveBinary("codex", { home, which: () => null, systemDirs: [] });
    expect(found).toBeNull();
  });

  /**
   * A directory named `claude` is not an installation. Without this check the
   * fallback would report ~/.local/bin/claude as installed for anyone who has
   * such a directory, and the CLI spawn would then fail with EACCES.
   */
  it("ignores a directory sharing the binary's name", async () => {
    await mkdir(join(home, ".local", "bin", "claude"), { recursive: true });
    const found = await resolveBinary("claude", { home, which: () => null, systemDirs: [] });
    expect(found).toBeNull();
  });

  it("ignores a non-executable file", async () => {
    const path = join(home, ".local", "bin", "claude");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(path, "not executable");
    await chmod(path, 0o644);
    const found = await resolveBinary("claude", { home, which: () => null, systemDirs: [] });
    expect(found).toBeNull();
  });

  /**
   * The second false negative, found the same way as the first: an agent CLI
   * that is not a CLI. The OpenAI ChatGPT extension ships `codex` inside its
   * own extension directory — off PATH, and not under ~/.codex/bin either — so
   * every fixed-directory lookup reported the tool absent while it was in
   * active use. Undetected means unregistered, and unregistered used to mean
   * no skills.
   */
  describe("editor extension bundles", () => {
    const roots = [[".vscode", "extensions"], [".trae", "extensions"]];

    it("finds a binary under <ext>/bin/<arch>/<name>", async () => {
      const path = await makeExecutable(
        ".vscode",
        "extensions",
        "openai.chatgpt-26.803.41515-darwin-arm64",
        "bin",
        "macos-aarch64",
        "codex"
      );
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: roots,
      });
      expect(found).toBe(path);
    });

    it("finds a binary under <ext>/bin/<name>", async () => {
      const path = await makeExecutable(".trae", "extensions", "some.ext-1.0.0", "bin", "codex");
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: roots,
      });
      expect(found).toBe(path);
    });

    it("prefers a fixed directory over an extension bundle", async () => {
      const stable = await makeExecutable(".local", "bin", "codex");
      await makeExecutable(".vscode", "extensions", "some.ext-1.0.0", "bin", "codex");
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: roots,
      });
      expect(found).toBe(stable);
    });

    it("returns null when no extension ships the binary", async () => {
      await makeExecutable(".vscode", "extensions", "unrelated.ext-1.0.0", "bin", "something-else");
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: roots,
      });
      expect(found).toBeNull();
    });

    it("survives an extension directory without a bin/", async () => {
      await mkdir(join(home, ".vscode", "extensions", "plain.ext-1.0.0"), { recursive: true });
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: roots,
      });
      expect(found).toBeNull();
    });

    it("skips the scan entirely when extensionRoots is empty", async () => {
      await makeExecutable(".vscode", "extensions", "some.ext-1.0.0", "bin", "codex");
      const found = await resolveBinary("codex", {
        home,
        which: () => null,
        systemDirs: [],
        extensionRoots: [],
      });
      expect(found).toBeNull();
    });
  });
});
