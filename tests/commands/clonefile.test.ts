import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneTree } from "../../src/commands/clonefile.js";

describe("cloneTree", () => {
  const darwin = process.platform === "darwin";

  it.skipIf(!darwin)("clones a directory with its files and relative symlinks, and refuses an existing target", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-clone-"));
    try {
      const source = join(root, "src");
      mkdirSync(join(source, "pkg"), { recursive: true });
      writeFileSync(join(source, "pkg", "index.js"), "export {};\n");
      symlinkSync("pkg/index.js", join(source, "link.js"));

      const target = join(root, "dst");
      // The temp dir may sit on a filesystem without cloning; the contract then is "false", not a throw.
      if (!cloneTree(source, target)) {
        expect(existsSync(target)).toBe(false);
        return;
      }
      expect(readFileSync(join(target, "pkg", "index.js"), "utf-8")).toBe("export {};\n");
      expect(lstatSync(join(target, "link.js")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(target, "link.js"))).toBe("pkg/index.js");
      expect(cloneTree(source, target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false for a missing source instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "pb-clone-"));
    try {
      expect(cloneTree(join(root, "nope"), join(root, "dst"))).toBe(false);
      expect(existsSync(join(root, "dst"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
