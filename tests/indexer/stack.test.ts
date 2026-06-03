import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectStack, buildProjectContext } from "../../src/indexer/stack.js";

describe("stack detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "stack-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("detectStack", () => {
    it("detects TypeScript from package.json", async () => {
      await Bun.write(
        join(tempDir, "package.json"),
        JSON.stringify({ devDependencies: { typescript: "^5.0" } })
      );

      const stack = await detectStack(tempDir);
      expect(stack.languages).toContain("TypeScript");
      expect(stack.manifest).toBe("package.json");
    });

    it("detects Go from go.mod", async () => {
      await Bun.write(
        join(tempDir, "go.mod"),
        "module example.com/app\n\ngo 1.21\n"
      );

      const stack = await detectStack(tempDir);
      expect(stack.languages).toContain("Go");
      expect(stack.manifest).toBe("go.mod");
    });

    it("detects Rust from Cargo.toml", async () => {
      await Bun.write(
        join(tempDir, "Cargo.toml"),
        '[package]\nname = "myapp"\nversion = "0.1.0"\n'
      );

      const stack = await detectStack(tempDir);
      expect(stack.languages).toContain("Rust");
      expect(stack.manifest).toBe("Cargo.toml");
    });

    it("detects Python from pyproject.toml", async () => {
      await Bun.write(
        join(tempDir, "pyproject.toml"),
        "[project]\nname = \"myapp\"\n"
      );

      const stack = await detectStack(tempDir);
      expect(stack.languages).toContain("Python");
      expect(stack.manifest).toBe("pyproject.toml");
    });

    it("detects Elixir from mix.exs", async () => {
      await Bun.write(
        join(tempDir, "mix.exs"),
        "defmodule MyApp.MixProject do\nend\n"
      );

      const stack = await detectStack(tempDir);
      expect(stack.languages).toContain("Elixir");
      expect(stack.manifest).toBe("mix.exs");
    });

    it("detects package manager from bun.lockb", async () => {
      await Bun.write(join(tempDir, "package.json"), "{}");
      await Bun.write(join(tempDir, "bun.lockb"), "");

      const stack = await detectStack(tempDir);
      expect(stack.packageManager).toBe("bun");
    });

    it("detects package manager from pnpm-lock.yaml", async () => {
      await Bun.write(join(tempDir, "package.json"), "{}");
      await Bun.write(join(tempDir, "pnpm-lock.yaml"), "");

      const stack = await detectStack(tempDir);
      expect(stack.packageManager).toBe("pnpm");
    });

    it("detects package manager from yarn.lock", async () => {
      await Bun.write(join(tempDir, "package.json"), "{}");
      await Bun.write(join(tempDir, "yarn.lock"), "");

      const stack = await detectStack(tempDir);
      expect(stack.packageManager).toBe("yarn");
    });

    it("detects package manager from package-lock.json", async () => {
      await Bun.write(join(tempDir, "package.json"), "{}");
      await Bun.write(join(tempDir, "package-lock.json"), "{}");

      const stack = await detectStack(tempDir);
      expect(stack.packageManager).toBe("npm");
    });
  });

  describe("buildProjectContext", () => {
    it("returns name, root, stack, files, modules", async () => {
      await Bun.write(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test-project" })
      );
      await mkdir(join(tempDir, "src"), { recursive: true });
      await mkdir(join(tempDir, "tests"), { recursive: true });
      await mkdir(join(tempDir, ".git"), { recursive: true });
      await Bun.write(join(tempDir, "src", "main.ts"), "export const x = 1;");

      const ctx = await buildProjectContext(tempDir);
      expect(ctx.name).toBe("test-project");
      expect(ctx.root).toBe(tempDir);
      expect(ctx.stack).toBeDefined();
      expect(Array.isArray(ctx.modules)).toBe(true);
    });
  });
});
