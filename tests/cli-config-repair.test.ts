import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * The repair is wired into cli.ts's top-level preamble, which no unit test can
 * reach — it runs at module load, before any export exists. These spawn the
 * real CLI against a throwaway HOME, which is the only way to prove the wiring
 * (not just the repair functions) actually fires.
 */
describe("CLI preamble repairs stale host configs", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cli-repair-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function runCli(): Promise<{ stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], {
      env: {
        ...process.env,
        HOME: home,
        // Isolate the assertion from the neighbouring preamble blocks.
        BRAIN_NO_UPDATE_CHECK: "1",
        BRAIN_NO_SKILL_REFRESH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { stdout, stderr };
  }

  it("rewrites a broken entry and reports it on stderr, never stdout", async () => {
    const configPath = join(home, ".claude.json");
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

    const { stdout, stderr } = await runCli();

    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers["project-brain"]).toEqual({
      command: "/opt/homebrew/bin/project-brain",
      args: [],
      transport: "stdio",
    });

    expect(stderr).toContain("fixed the MCP launch command");
    // `serve` reaches this same preamble and stdout is its JSON-RPC channel —
    // a single stray byte there corrupts the protocol.
    expect(stdout).not.toContain("fixed the MCP launch command");
  }, 30_000);

  it("stays silent and byte-identical on an already-correct config", async () => {
    const configPath = join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: {
        "project-brain": {
          command: "/opt/homebrew/bin/project-brain",
          args: [],
        },
      },
    });
    await Bun.write(configPath, original);

    const { stderr } = await runCli();

    expect(stderr).not.toContain("fixed the MCP launch command");
    expect(await Bun.file(configPath).text()).toBe(original);
  }, 30_000);

  it("honors BRAIN_NO_CONFIG_REPAIR=1", async () => {
    const configPath = join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: {
        "project-brain": {
          command: "bun",
          args: ["/opt/homebrew/bin/project-brain"],
        },
      },
    });
    await Bun.write(configPath, original);

    const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], {
      env: {
        ...process.env,
        HOME: home,
        BRAIN_NO_UPDATE_CHECK: "1",
        BRAIN_NO_SKILL_REFRESH: "1",
        BRAIN_NO_CONFIG_REPAIR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    expect(await Bun.file(configPath).text()).toBe(original);
  }, 30_000);
});
