import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { forgetServer, parseProcessTable, readServers, recordServer, staleServers, type ProcessRow } from "../../src/hooks/session-versions.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const dataDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "pb-servers-"));
  dirs.push(d);
  return d;
};

describe("running server records", () => {
  it("records a server, prunes the records of dead ones, and forgets it on exit", async () => {
    const dir = await dataDir();
    await recordServer(dir, { pid: 999_999_1, version: "0.1.0", cwd: dir, startedAt: NOW });
    await recordServer(dir, { pid: process.pid, version: "0.2.0", cwd: dir, startedAt: NOW });
    expect((await readServers(dir)).map((r) => r.pid)).toEqual([process.pid]);

    forgetServer(dir, process.pid);
    expect(await readServers(dir)).toEqual([]);
  });

  it("skips files that are not records", async () => {
    const dir = await dataDir();
    await recordServer(dir, { pid: process.pid, version: "0.2.0", cwd: dir, startedAt: NOW });
    await writeFile(join(dir, "servers", "notes.txt"), "x");
    await writeFile(join(dir, "servers", "12.json"), "{broken");
    expect((await readServers(dir)).map((r) => r.version)).toEqual(["0.2.0"]);
    expect((await readdir(join(dir, "servers"))).includes("notes.txt")).toBe(true);
  });
});

describe("process table", () => {
  it("parses ps rows and their start times across etime formats", () => {
    const out = [
      "  101     1 05-04:08:27 /opt/homebrew/bin/project-brain",
      "  102   101    04:08:27 /opt/homebrew/bin/project-brain serve --worker",
      "  103     1       00:07 /usr/bin/My Apps/project-brain serve",
      "garbage",
    ].join("\n");
    expect(parseProcessTable(out, NOW)).toEqual([
      { pid: 101, ppid: 1, startedAt: NOW - (5 * 86_400 + 4 * 3600 + 8 * 60 + 27) * 1000, args: "/opt/homebrew/bin/project-brain" },
      { pid: 102, ppid: 101, startedAt: NOW - (4 * 3600 + 8 * 60 + 27) * 1000, args: "/opt/homebrew/bin/project-brain serve --worker" },
      { pid: 103, ppid: 1, startedAt: NOW - 7000, args: "/usr/bin/My Apps/project-brain serve" },
    ]);
  });
});

describe("stale servers", () => {
  const row = (pid: number, args: string, ppid = 1): ProcessRow => ({ pid, ppid, startedAt: NOW - pid, args });
  const live = () => true;

  it("judges a recorded server by its version and an unrecorded one as older", () => {
    const rows = [
      row(10, "/opt/homebrew/bin/project-brain"),
      row(11, "/opt/homebrew/bin/project-brain"),
      row(12, "/opt/homebrew/bin/project-brain"),
      row(13, "/opt/homebrew/bin/project-brain routing-rules"),
      row(14, "/usr/bin/vim project-brain"),
    ];
    const records = [
      { pid: 11, version: "0.46.0", cwd: "/a", startedAt: NOW - 11 },
      { pid: 12, version: "0.45.1", cwd: "/b", startedAt: NOW - 12 },
    ];
    expect(staleServers(rows, records, "0.46.0", live)).toEqual([
      { pid: 12, version: "0.45.1", cwd: "/b", startedAt: NOW - 12 },
      { pid: 10, version: null, cwd: null, startedAt: NOW - 10 },
    ]);
  });

  it("judges a hot-swap supervisor by its worker, recorded or not", () => {
    const rows = [
      row(20, "/opt/homebrew/bin/project-brain"),
      row(21, "/opt/homebrew/bin/project-brain serve --worker", 20),
      row(30, "/opt/homebrew/bin/project-brain"),
      row(31, "/opt/homebrew/bin/project-brain serve --worker", 30),
    ];
    const records = [{ pid: 21, version: "0.46.0", cwd: "/a", startedAt: NOW }];
    expect(staleServers(rows, records, "0.46.0", live).map((s) => s.pid)).toEqual([31]);
  });

  it("drops records of dead processes and still answers with no process table", () => {
    const records = [
      { pid: 40, version: "0.45.0", cwd: "/a", startedAt: NOW },
      { pid: 41, version: "0.45.0", cwd: "/b", startedAt: NOW },
    ];
    expect(staleServers([], records, "0.46.0", (pid) => pid === 41).map((s) => s.pid)).toEqual([41]);
  });
});
