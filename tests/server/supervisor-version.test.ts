import { describe, it, expect, afterEach } from "bun:test";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installedVersionProbe } from "../../src/server/supervisor-version.js";
import { handleHealth } from "../../src/tools/health.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore } from "../../src/types.js";

// The installed binary is a script behind a symlink that an upgrade retargets, as brew does.
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function install() {
  const dir = await mkdtemp(join(tmpdir(), "pb-installed-"));
  dirs.push(dir);
  const link = join(dir, "project-brain");
  let runs = 0;
  const point = async (version: string) => {
    const file = join(dir, `project-brain-${version}`);
    await writeFile(file, `#!/bin/sh\necho "project-brain ${version}"\n`);
    await chmod(file, 0o755);
    await rm(join(dir, ".tmp"), { force: true });
    await symlink(file, join(dir, ".tmp"));
    await rename(join(dir, ".tmp"), link);
  };
  const launcher = { argv: [link], watch: link };
  const counted = async () => {
    runs++;
    const { readLauncherVersion } = await import("../../src/server/supervisor.js");
    return readLauncherVersion(launcher);
  };
  return { point, launcher, readVersion: counted, runs: () => runs };
}

describe("installed version probe", () => {
  it("answers from the file's signature while it is unchanged, without running the binary", async () => {
    const i = await install();
    await i.point("0.45.1");
    const probe = installedVersionProbe({ launcher: i.launcher, running: "0.45.1", supervised: false, readVersion: i.readVersion });
    expect(await probe()).toEqual({ installedVersion: "0.45.1" });
    expect(i.runs()).toBe(0);
  });

  it("names both versions and the reconnect after an upgrade, asking the binary once", async () => {
    const i = await install();
    await i.point("0.42.0");
    const probe = installedVersionProbe({ launcher: i.launcher, running: "0.42.0", supervised: false, readVersion: i.readVersion });
    await i.point("0.45.1");
    const expected = {
      installedVersion: "0.45.1",
      versionDrift: "MCP server runs 0.42.0, installed 0.45.1: run /mcp reconnect (or restart Claude Code) to load it",
    };
    expect(await probe()).toEqual(expected);
    expect(await probe()).toEqual(expected);
    expect(i.runs()).toBe(1);
  });

  it("under the hot-swap supervisor, says the swap is coming", async () => {
    const i = await install();
    await i.point("0.42.0");
    const probe = installedVersionProbe({ launcher: i.launcher, running: "0.42.0", supervised: true, readVersion: i.readVersion });
    await i.point("0.45.1");
    expect((await probe())?.versionDrift).toBe(
      "MCP server runs 0.42.0, installed 0.45.1: the hot swap moves this session to it at the next idle moment; if this persists, run /mcp reconnect"
    );
  });

  it("when the new binary failed to start as a server, says so and does not advise a reconnect", async () => {
    const i = await install();
    await i.point("0.42.0");
    const probe = installedVersionProbe({
      launcher: i.launcher,
      running: "0.42.0",
      supervised: true,
      readVersion: i.readVersion,
      swapFailure: async () => ({ to: "0.45.1", reason: "new server exited early (code 3)", kind: "start" }),
    });
    await i.point("0.45.1");
    const drift = (await probe())?.versionDrift;
    expect(drift).toBe(
      `The installed project-brain 0.45.1 (${i.launcher.watch}) fails to start: new server exited early (code 3). This session keeps working on 0.42.0; reinstall project-brain or upgrade again.`
    );
    expect(drift).not.toContain("/mcp reconnect");
  });

  it("when a swap only missed its moment or the protocol changed, a reconnect is the fix", async () => {
    const i = await install();
    await i.point("0.42.0");
    const probe = installedVersionProbe({
      launcher: i.launcher,
      running: "0.42.0",
      supervised: true,
      readVersion: i.readVersion,
      swapFailure: async () => ({ to: "0.45.1", reason: "new server speaks MCP protocol 2024-11-05, this session uses 2025-06-18", kind: "protocol" }),
    });
    await i.point("0.45.1");
    expect((await probe())?.versionDrift).toBe(
      "MCP server runs 0.42.0, installed 0.45.1: the hot swap to it did not happen (new server speaks MCP protocol 2024-11-05, this session uses 2025-06-18); run /mcp reconnect to load it"
    );
  });

  it("ignores a failure recorded for another version", async () => {
    const i = await install();
    await i.point("0.42.0");
    const probe = installedVersionProbe({
      launcher: i.launcher,
      running: "0.42.0",
      supervised: true,
      readVersion: i.readVersion,
      swapFailure: async () => ({ to: "0.44.0", reason: "old" }),
    });
    await i.point("0.45.1");
    expect((await probe())?.versionDrift).toContain("the hot swap moves this session to it");
  });

  it("says nothing about a launcher it cannot read", async () => {
    const missing = installedVersionProbe({ launcher: { argv: ["/nonexistent"], watch: "/nonexistent" }, running: "1.0.0" });
    expect(await missing()).toBeNull();
  });

  it("reports an installed binary that does not start, asking it once per change", async () => {
    const i = await install();
    await i.point("0.42.0");
    let asked = 0;
    const probe = installedVersionProbe({
      launcher: i.launcher,
      running: "0.42.0",
      probeVersion: async () => (asked++, { error: "--version exited with code 1: dyld: missing symbol" }),
    });
    await i.point("0.45.1");
    const expected = {
      versionDrift: `The installed project-brain (${i.launcher.watch}) fails to start: --version exited with code 1: dyld: missing symbol. This session keeps working on 0.42.0; reinstall project-brain or upgrade again.`,
    };
    expect(await probe()).toEqual(expected);
    expect(await probe()).toEqual(expected);
    expect(asked).toBe(1);
  });

  it("reads only project-brain's own --version line, never another program's version", async () => {
    const i = await install();
    const { probeLauncherVersion } = await import("../../src/server/supervisor.js");
    const bunLike = join(dirs.at(-1)!, "bun-like");
    await writeFile(bunLike, `#!/bin/sh\necho "1.3.14"\n`);
    await chmod(bunLike, 0o755);
    expect(await probeLauncherVersion({ argv: [bunLike], watch: bunLike })).toEqual({ error: "--version printed no project-brain version" });
    await i.point("2.0.0");
    expect(await probeLauncherVersion(i.launcher)).toEqual({ version: "2.0.0" });
  });

  it("does not flag a server newer than the installed binary: reconnecting would load the older one", async () => {
    const i = await install();
    await i.point("0.45.1");
    const probe = installedVersionProbe({ launcher: i.launcher, running: "0.46.0", supervised: false, readVersion: i.readVersion });
    await i.point("0.45.0");
    expect(await probe()).toEqual({ installedVersion: "0.45.0" });
  });
});

describe("check_health", () => {
  const store = { countChunks: async () => 1 } as unknown as VectorStore;
  const embeddings: EmbeddingClient = { dim: VECTOR_DIM, embed: async () => [[0.1]], isAvailable: async () => true };

  it("reports the installed version and the drift next to the running one", async () => {
    const drift = { installedVersion: "0.45.1", versionDrift: "MCP server runs 0.42.0, installed 0.45.1: run /mcp reconnect (or restart Claude Code) to load it" };
    const result = await handleHealth({ project: "demo" }, { store, embeddings }, async () => drift);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject(drift);
  });

  it("leaves both fields out when the probe cannot tell, and never fails on it", async () => {
    const result = await handleHealth({ project: "demo" }, { store, embeddings }, async () => {
      throw new Error("boom");
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.installedVersion).toBeUndefined();
    expect(data.versionDrift).toBeUndefined();
  });
});
