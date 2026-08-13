import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  repairTomlLaunch,
  repairTomlFile,
  repairAllConfigs,
} from "../../src/registrars/repair.js";

describe("repairTomlLaunch", () => {
  it("rewrites a bun-prefixed binary to a direct command and drops the args line", () => {
    const toml = [
      "[mcp_servers.project-brain]",
      'command = "bun"',
      'args = ["/opt/homebrew/bin/project-brain"]',
      "",
    ].join("\n");

    expect(repairTomlLaunch(toml)).toBe(
      ['[mcp_servers.project-brain]', 'command = "/opt/homebrew/bin/project-brain"', ""].join(
        "\n"
      )
    );
  });

  it("preserves comments and every other server in the file", () => {
    // A parse-and-reserialize repair would silently drop the comment. This
    // project already refuses that trade for JSONC; TOML gets the same rule.
    const toml = [
      "# hand-written, do not clobber",
      "[mcp_servers.figma]",
      'url = "https://mcp.figma.com/mcp"',
      "",
      "[mcp_servers.project-brain]",
      'command = "bun"',
      'args = ["/opt/homebrew/bin/project-brain"]',
      "",
      "[mcp_servers.other]",
      'command = "bun"',
      'args = ["/opt/homebrew/bin/other"]',
      "",
    ].join("\n");

    const out = repairTomlLaunch(toml)!;

    expect(out).toContain("# hand-written, do not clobber");
    expect(out).toContain('url = "https://mcp.figma.com/mcp"');
    // The identically-shaped `other` server is not ours to rewrite.
    expect(out).toContain('[mcp_servers.other]\ncommand = "bun"');
    expect(out).toContain(
      '[mcp_servers.project-brain]\ncommand = "/opt/homebrew/bin/project-brain"'
    );
  });

  it("stops at the next table and leaves a trailing env subtable intact", () => {
    const toml = [
      "[mcp_servers.project-brain]",
      'command = "bun"',
      'args = ["/opt/homebrew/bin/project-brain"]',
      "",
      "[mcp_servers.project-brain.env]",
      'BRAIN_DATA_DIR = "/data"',
      "",
    ].join("\n");

    const out = repairTomlLaunch(toml)!;

    expect(out).toContain('command = "/opt/homebrew/bin/project-brain"');
    expect(out).toContain("[mcp_servers.project-brain.env]");
    expect(out).toContain('BRAIN_DATA_DIR = "/data"');
  });

  it("returns null for an already-correct direct command", () => {
    const toml = [
      "[mcp_servers.project-brain]",
      'command = "/usr/local/bin/project-brain"',
      "",
    ].join("\n");

    expect(repairTomlLaunch(toml)).toBeNull();
  });

  it("returns null for a bun-run source entrypoint", () => {
    const toml = [
      "[mcp_servers.project-brain]",
      'command = "bun"',
      'args = ["/repo/src/cli.ts"]',
      "",
    ].join("\n");

    expect(repairTomlLaunch(toml)).toBeNull();
  });

  it("returns null when args carry extra runtime flags", () => {
    const toml = [
      "[mcp_servers.project-brain]",
      'command = "bun"',
      'args = ["--smol", "/opt/homebrew/bin/project-brain"]',
      "",
    ].join("\n");

    expect(repairTomlLaunch(toml)).toBeNull();
  });

  it("returns null when the file has no project-brain table", () => {
    expect(
      repairTomlLaunch('[mcp_servers.figma]\nurl = "https://x"\n')
    ).toBeNull();
  });
});

describe("repairTomlFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "repair-toml-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rewrites the file and reports true", async () => {
    const p = join(tempDir, "config.toml");
    await Bun.write(
      p,
      '[mcp_servers.project-brain]\ncommand = "bun"\nargs = ["/opt/homebrew/bin/project-brain"]\n'
    );

    expect(await repairTomlFile(p)).toBe(true);
    expect(await Bun.file(p).text()).toBe(
      '[mcp_servers.project-brain]\ncommand = "/opt/homebrew/bin/project-brain"\n'
    );
  });

  it("leaves a correct file byte-identical and reports false", async () => {
    const p = join(tempDir, "config.toml");
    const original =
      '# keep me\n[mcp_servers.project-brain]\ncommand = "/usr/local/bin/project-brain"\n';
    await Bun.write(p, original);

    expect(await repairTomlFile(p)).toBe(false);
    expect(await Bun.file(p).text()).toBe(original);
  });

  it("reports false for an absent file", async () => {
    expect(await repairTomlFile(join(tempDir, "nope.toml"))).toBe(false);
  });
});

describe("repairAllConfigs covers Codex's TOML", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "repair-all-toml-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("repairs a TOML host and names it", async () => {
    const p = join(tempDir, "config.toml");
    await Bun.write(
      p,
      '[mcp_servers.project-brain]\ncommand = "bun"\nargs = ["/opt/homebrew/bin/project-brain"]\n'
    );

    const codexLike = {
      name: "Codex",
      isInstalled: async () => true,
      register: async () => {},
      writeRules: async () => {},
      mcpTomlConfigPath: () => p,
    };

    expect(await repairAllConfigs([codexLike] as any)).toEqual(["Codex"]);
    expect(await Bun.file(p).text()).toContain(
      'command = "/opt/homebrew/bin/project-brain"'
    );
  });
});
