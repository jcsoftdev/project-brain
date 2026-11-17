import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { baseProjectId } from "../../src/commands/init.js";

function checkout(projectJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), "pb-base-id-"));
  if (projectJson !== undefined) {
    mkdirSync(join(root, ".project-brain"));
    writeFileSync(join(root, ".project-brain", "project.json"), projectJson);
  }
  return root;
}

describe("baseProjectId", () => {
  test("a recorded id wins over the derived one, so a renamed repo still seeds its worktrees", async () => {
    const root = checkout(JSON.stringify({ projectId: "wappido" }));
    try {
      expect(await baseProjectId(root)).toBe("wappido");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([[undefined], ["not json"], [JSON.stringify({ projectId: "" })]])(
    "falls back to the derived id when the config is %p",
    async (config) => {
      const root = checkout(config);
      try {
        expect(await baseProjectId(root)).toBe(basename(root));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
