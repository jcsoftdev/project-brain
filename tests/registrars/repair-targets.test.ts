import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";
import { CursorRegistrar } from "../../src/registrars/cursor.js";
import { WindsurfRegistrar } from "../../src/registrars/windsurf.js";
import { OpencodeRegistrar } from "../../src/registrars/opencode.js";
import { GeminiRegistrar } from "../../src/registrars/gemini.js";
import { ZedRegistrar } from "../../src/registrars/zed.js";
import { VSCodeRegistrar } from "../../src/registrars/vscode.js";

/**
 * A repair pass can only find an entry it can locate. If mcpConfigTarget() ever
 * drifts from where register() actually writes, the repair silently no-ops and
 * the user stays broken with no error anywhere — so this asserts the two agree
 * by construction rather than restating the paths as a second source of truth.
 */
describe("mcpConfigTarget agrees with where register() writes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "repair-targets-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; make: (dir: string) => AIToolRegistrar }> = [
    // Claude's MCP config is the HOME-ROOT dotfile, not baseDir — hence the
    // third constructor arg. Its CLI runner is forced to fail so register()
    // takes the JSON fallback offline.
    {
      name: "Claude Code",
      make: (dir) => new ClaudeRegistrar(dir, async () => false, dir),
    },
    { name: "Cursor", make: (dir) => new CursorRegistrar(dir) },
    { name: "Windsurf", make: (dir) => new WindsurfRegistrar(dir) },
    { name: "Opencode", make: (dir) => new OpencodeRegistrar(dir) },
    { name: "Gemini", make: (dir) => new GeminiRegistrar(dir) },
    { name: "Zed", make: (dir) => new ZedRegistrar(dir) },
    { name: "VS Code", make: (dir) => new VSCodeRegistrar(dir) },
  ];

  for (const { name, make } of cases) {
    it(`${name} reports the file and key register() actually wrote`, async () => {
      const registrar = make(tempDir);
      await registrar.register("/opt/homebrew/bin/project-brain");

      const target = registrar.mcpConfigTarget?.();
      expect(target).toBeDefined();

      const config = JSON.parse(await Bun.file(target!.path).text());
      expect(config[target!.containerKey]?.["project-brain"]).toBeDefined();
    });
  }
});
