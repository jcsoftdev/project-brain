import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirExists,
  upsertJsonConfig,
  standardServerEntry,
  UnparseableConfigError,
} from "../../src/registrars/json-config.js";

describe("json-config helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "json-config-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("upsertJsonConfig", () => {
    it("creates the file when absent, including parent mkdir", async () => {
      const configPath = join(tempDir, "nested", "dir", "config.json");

      await upsertJsonConfig(configPath, (config) => {
        config.mcpServers ??= {};
        config.mcpServers["project-brain"] = standardServerEntry(
          "/usr/local/bin/project-brain"
        );
      });

      const config = JSON.parse(await Bun.file(configPath).text());
      expect(config.mcpServers["project-brain"]).toBeDefined();
      expect(config.mcpServers["project-brain"].command).toBe("bun");
    });

    it("merges into existing JSON, preserving unrelated keys", async () => {
      const configPath = join(tempDir, "config.json");
      await Bun.write(
        configPath,
        JSON.stringify({
          mcpServers: { other: { command: "bar" } },
          otherSetting: true,
        })
      );

      await upsertJsonConfig(configPath, (config) => {
        config.mcpServers ??= {};
        config.mcpServers["project-brain"] = standardServerEntry(
          "/usr/local/bin/project-brain"
        );
      });

      const config = JSON.parse(await Bun.file(configPath).text());
      expect(config.otherSetting).toBe(true);
      expect(config.mcpServers.other).toBeDefined();
      expect(config.mcpServers["project-brain"]).toBeDefined();
    });

    it("throws UnparseableConfigError on invalid JSON and never writes", async () => {
      const configPath = join(tempDir, "config.json");
      const original = "{ this is not valid json ][";
      await Bun.write(configPath, original);

      await expect(
        upsertJsonConfig(configPath, (config) => {
          config.mcpServers ??= {};
          config.mcpServers["project-brain"] = standardServerEntry(
            "/usr/local/bin/project-brain"
          );
        })
      ).rejects.toThrow(UnparseableConfigError);

      const afterContent = await Bun.file(configPath).text();
      expect(afterContent).toBe(original);
    });

    it("UnparseableConfigError message includes the config path", async () => {
      const configPath = join(tempDir, "config.json");
      await Bun.write(configPath, "{ nope");

      try {
        await upsertJsonConfig(configPath, (config) => {
          config.mcpServers ??= {};
        });
        throw new Error("expected upsertJsonConfig to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UnparseableConfigError);
        expect((err as Error).message).toContain(configPath);
      }
    });

    it("throws UnparseableConfigError on JSONC with comments and never writes (no silent comment-stripping rewrite)", async () => {
      const configPath = join(tempDir, "config.json");
      const original = [
        "{",
        '  // this is a JSONC comment',
        '  "mcpServers": { "other": { "command": "bar" } }',
        "}",
      ].join("\n");
      await Bun.write(configPath, original);

      await expect(
        upsertJsonConfig(configPath, (config) => {
          config.mcpServers ??= {};
          config.mcpServers["project-brain"] = standardServerEntry(
            "/usr/local/bin/project-brain"
          );
        })
      ).rejects.toThrow(UnparseableConfigError);

      const afterContent = await Bun.file(configPath).text();
      expect(afterContent).toBe(original);
    });

    it("cleans up the tmp file after a successful atomic write (no .tmp left behind)", async () => {
      const configPath = join(tempDir, "config.json");

      await upsertJsonConfig(configPath, (config) => {
        config.mcpServers ??= {};
        config.mcpServers["project-brain"] = standardServerEntry(
          "/usr/local/bin/project-brain"
        );
      });

      const entries = await readdir(tempDir);
      const tmpLeftovers = entries.filter((name) => name.includes(".tmp-"));
      expect(tmpLeftovers).toEqual([]);
    });
  });

  describe("dirExists", () => {
    it("returns true for a real directory", async () => {
      expect(await dirExists(tempDir)).toBe(true);
    });

    it("returns false for a bogus path", async () => {
      expect(await dirExists(join(tempDir, "does-not-exist"))).toBe(false);
    });
  });

  describe("standardServerEntry", () => {
    it("returns the standard mcpServers shape", () => {
      expect(standardServerEntry("/x/cli.ts")).toEqual({
        command: "bun",
        args: ["/x/cli.ts"],
        transport: "stdio",
      });
    });
  });
});
