import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  repairConfigFile,
  repairAllConfigs,
} from "../../src/registrars/repair.js";

describe("repairConfigFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "repair-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rewrites a broken project-brain entry and reports it repaired", async () => {
    const configPath = join(tempDir, "mcp.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: {
          "project-brain": {
            command: "bun",
            args: ["/opt/homebrew/bin/project-brain"],
            transport: "stdio",
          },
        },
      })
    );

    expect(await repairConfigFile(configPath, "mcpServers")).toBe(true);

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers["project-brain"]).toEqual({
      command: "/opt/homebrew/bin/project-brain",
      args: [],
      transport: "stdio",
    });
  });

  it("never touches other servers in the same file", async () => {
    const configPath = join(tempDir, "mcp.json");
    const other = { command: "bun", args: ["/opt/homebrew/bin/other-tool"] };
    await Bun.write(
      configPath,
      JSON.stringify({
        mcpServers: {
          other,
          "project-brain": {
            command: "bun",
            args: ["/opt/homebrew/bin/project-brain"],
          },
        },
        unrelatedSetting: true,
      })
    );

    await repairConfigFile(configPath, "mcpServers");

    const config = JSON.parse(await Bun.file(configPath).text());
    // `other` looks identically "broken" but is not ours to judge or rewrite.
    expect(config.mcpServers.other).toEqual(other);
    expect(config.unrelatedSetting).toBe(true);
  });

  it("honors a non-default container key (Zed's context_servers)", async () => {
    const configPath = join(tempDir, "settings.json");
    await Bun.write(
      configPath,
      JSON.stringify({
        context_servers: {
          "project-brain": {
            command: "bun",
            args: ["/usr/local/bin/project-brain"],
          },
        },
      })
    );

    expect(await repairConfigFile(configPath, "context_servers")).toBe(true);

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.context_servers["project-brain"].command).toBe(
      "/usr/local/bin/project-brain"
    );
  });

  it("reports false and rewrites nothing when the entry is already correct", async () => {
    const configPath = join(tempDir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        "project-brain": {
          command: "/opt/homebrew/bin/project-brain",
          args: [],
        },
      },
    });
    await Bun.write(configPath, original);

    expect(await repairConfigFile(configPath, "mcpServers")).toBe(false);
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  it("reports false for a config file that does not exist", async () => {
    expect(
      await repairConfigFile(join(tempDir, "absent.json"), "mcpServers")
    ).toBe(false);
  });

  it("reports false for an unparseable config instead of destroying it", async () => {
    const configPath = join(tempDir, "mcp.json");
    const original = "{ mid-edit, not json ][";
    await Bun.write(configPath, original);

    expect(await repairConfigFile(configPath, "mcpServers")).toBe(false);
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  it("reports false when the file has no project-brain entry at all", async () => {
    const configPath = join(tempDir, "mcp.json");
    await Bun.write(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "x" } } })
    );

    expect(await repairConfigFile(configPath, "mcpServers")).toBe(false);
  });
});

describe("repairAllConfigs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "repair-all-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function fakeRegistrar(name: string, file: string, containerKey: string) {
    return {
      name,
      isInstalled: async () => true,
      register: async () => {},
      writeRules: async () => {},
      mcpConfigTarget: () => ({ path: join(tempDir, file), containerKey }),
    };
  }

  async function writeConfig(file: string, containerKey: string, entry: unknown) {
    await Bun.write(
      join(tempDir, file),
      JSON.stringify({ [containerKey]: { "project-brain": entry } })
    );
  }

  it("returns the names of only the hosts it actually repaired", async () => {
    await writeConfig("a.json", "mcpServers", {
      command: "bun",
      args: ["/opt/homebrew/bin/project-brain"],
    });
    await writeConfig("b.json", "servers", {
      command: "/opt/homebrew/bin/project-brain",
      args: [],
    });

    const repaired = await repairAllConfigs([
      fakeRegistrar("Broken Host", "a.json", "mcpServers"),
      fakeRegistrar("Healthy Host", "b.json", "servers"),
    ] as any);

    expect(repaired).toEqual(["Broken Host"]);
  });

  it("skips registrars that expose no JSON config target (Codex)", async () => {
    const codexLike = {
      name: "Codex",
      isInstalled: async () => true,
      register: async () => {},
      writeRules: async () => {},
    };

    expect(await repairAllConfigs([codexLike] as any)).toEqual([]);
  });

  it("keeps repairing after one host's config throws", async () => {
    await writeConfig("good.json", "mcpServers", {
      command: "bun",
      args: ["/opt/homebrew/bin/project-brain"],
    });
    const exploding = {
      name: "Exploding Host",
      isInstalled: async () => true,
      register: async () => {},
      writeRules: async () => {},
      mcpConfigTarget: () => {
        throw new Error("boom");
      },
    };

    const repaired = await repairAllConfigs([
      exploding,
      fakeRegistrar("Good Host", "good.json", "mcpServers"),
    ] as any);

    expect(repaired).toEqual(["Good Host"]);
  });
});
