import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  forgetServer,
  isServeCommand,
  liveServers,
  parseProcessTable,
  readServers,
  recordServer,
  staleServers,
  type ProcessRow,
} from "../../src/hooks/session-versions.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const DEAD_PID = 999_999_1;
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const dataDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "pb-servers-"));
  dirs.push(d);
  return d;
};
const BREW = "/opt/homebrew/bin/project-brain";
const row = (pid: number, args: string, more: Partial<ProcessRow> = {}): ProcessRow => ({
  pid,
  ppid: 1,
  uid: 501,
  startedAt: NOW - 3_600_000,
  comm: args.split(" ")[0]!,
  args,
  ...more,
});

describe("running server records", () => {
  it("records a server, prunes the records of dead ones, and forgets it on exit", async () => {
    const dir = await dataDir();
    await recordServer(dir, { pid: DEAD_PID, version: "0.1.0", cwd: dir, startedAt: NOW });
    await recordServer(dir, { pid: process.pid, version: "0.2.0", cwd: dir, startedAt: NOW });
    expect((await readServers(dir)).map((r) => r.pid)).toEqual([process.pid]);

    forgetServer(dir, process.pid);
    expect(await readServers(dir)).toEqual([]);
  });

  it("removes temp files an interrupted write left behind once they are old, and keeps fresh ones", async () => {
    const dir = await dataDir();
    await recordServer(dir, { pid: process.pid, version: "0.2.0", cwd: dir, startedAt: NOW });
    const servers = join(dir, "servers");
    await writeFile(join(servers, "41.json.41.abc123.tmp"), "{");
    await writeFile(join(servers, "42.json.42.def456.tmp"), "{");
    await utimes(join(servers, "41.json.41.abc123.tmp"), new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));
    await utimes(join(servers, "42.json.42.def456.tmp"), new Date(NOW - 60_000), new Date(NOW - 60_000));
    await recordServer(dir, { pid: process.pid, version: "0.2.0", cwd: dir, startedAt: NOW });
    expect((await readdir(servers)).sort()).toEqual([`${process.pid}.json`, "42.json.42.def456.tmp"].sort());
  });

  it("keeps a record only while its pid is still the server that wrote it, and removes the rest", async () => {
    const dir = await dataDir();
    const started = NOW - 86_400_000;
    await mkdir(join(dir, "servers"));
    for (const pid of [10, 11, 12])
      await writeFile(join(dir, "servers", `${pid}.json`), JSON.stringify({ pid, version: "0.40.0", cwd: dir, startedAt: started }));
    const rows = [
      row(10, BREW, { startedAt: started - 400 }), // the server itself
      row(11, BREW, { startedAt: NOW - 60_000 }), // pid recycled by a later server
      row(12, "/sbin/launchd", { startedAt: started - 400 }), // pid recycled by something else
    ];
    expect((await liveServers(dir, rows, NOW)).map((r) => r.pid)).toEqual([10]);
    expect(await readdir(join(dir, "servers"))).toEqual(["10.json"]);
  });
});

describe("process table", () => {
  it("joins both ps reads by pid, keeping spaces in paths, across etime formats", () => {
    const meta = [
      "  101     1   501 05-04:08:27 /opt/homebrew/bin/project-brain",
      "  102   101   501    04:08:27 /Users/me/My Apps/project-brain",
      "  103     1     0       00:07 launchd",
      "garbage",
    ].join("\n");
    const args = ["  101 /opt/homebrew/bin/project-brain", "  102 /Users/me/My Apps/project-brain serve --worker"].join("\n");
    expect(parseProcessTable(meta, args, NOW)).toEqual([
      { pid: 101, ppid: 1, uid: 501, startedAt: NOW - (5 * 86_400 + 4 * 3600 + 8 * 60 + 27) * 1000, comm: BREW, args: BREW },
      { pid: 102, ppid: 101, uid: 501, startedAt: NOW - (4 * 3600 + 8 * 60 + 27) * 1000, comm: "/Users/me/My Apps/project-brain", args: "/Users/me/My Apps/project-brain serve --worker" },
      { pid: 103, ppid: 1, uid: 0, startedAt: NOW - 7000, comm: "launchd", args: "launchd" },
    ]);
  });

  const cases: [string, string, string, boolean][] = [
    ["brew binary, no command", BREW, BREW, true],
    ["hot-swap worker", BREW, `${BREW} serve --worker`, true],
    ["linux comm is the short name", "project-brain", "/usr/local/bin/project-brain serve", true],
    ["path with spaces", "/Users/me/My Apps/project-brain", "/Users/me/My Apps/project-brain", true],
    ["npm native binary", "/n/project-brain-linux-x64/bin/project-brain-native", "/n/project-brain-linux-x64/bin/project-brain-native", true],
    ["npm shim under node", "node", "node /usr/lib/node_modules/project-brain/bin/project-brain", true],
    ["editor opening the checkout", "nvim", "nvim /Users/me/code/project-brain", false],
    ["electron opening the checkout", "/Applications/Code.app/Contents/MacOS/Electron", "/Applications/Code.app/Contents/MacOS/Electron /Users/me/personal/project-brain", false],
    ["a sibling binary", "/opt/homebrew/bin/project-brain-landing", "/opt/homebrew/bin/project-brain-landing", false],
    ["a hook command", BREW, `${BREW} routing-rules`, false],
    ["status itself", BREW, `${BREW} status`, false],
    ["any project's src/cli.ts", "bun", "bun /Users/me/other/src/cli.ts", false],
  ];
  for (const [name, comm, args, expected] of cases)
    it(`server command: ${name}`, () => expect(isServeCommand({ comm, args })).toBe(expected));

  it("accepts a checkout's src/cli.ts only when a record vouches for it", () => {
    const dev = { comm: "/Users/me/.bun/bin/bun", args: "/Users/me/.bun/bin/bun /Users/me/project-brain/src/cli.ts serve" };
    expect(isServeCommand(dev)).toBe(false);
    expect(isServeCommand(dev, true)).toBe(true);
    expect(isServeCommand({ ...dev, args: `${dev.args.replace(" serve", " sync")}` }, true)).toBe(false);
  });
});

describe("stale servers", () => {
  const installedAt = NOW - 86_400_000;

  it("reports only servers older than installed: recorded by version, unrecorded when they predate the install", () => {
    const rows = [
      row(10, BREW, { startedAt: installedAt - 1000 }),
      row(11, BREW),
      row(12, BREW),
      row(13, BREW),
      row(14, BREW, { startedAt: installedAt + 1000 }), // started from the installed binary under another HOME
      row(15, BREW, { startedAt: installedAt - 1000, uid: 0 }), // another user's
    ];
    const records = [
      { pid: 11, version: "0.46.0", cwd: "/a", startedAt: NOW - 11 },
      { pid: 12, version: "0.45.1", cwd: "/b", startedAt: NOW - 12 },
      { pid: 13, version: "0.47.0-dev", cwd: "/c", startedAt: NOW - 13 }, // newer, from source
    ];
    expect(staleServers(rows, records, "0.46.0", { uid: 501, installedAt })).toEqual([
      { pid: 10, version: null, cwd: null, startedAt: installedAt - 1000 },
      { pid: 12, version: "0.45.1", cwd: "/b", startedAt: NOW - 12 },
    ]);
  });

  it("does not guess about unrecorded servers when the install time is unknown", () => {
    expect(staleServers([row(10, BREW, { startedAt: installedAt - 1000 })], [], "0.46.0", { uid: 501, installedAt: null })).toEqual([]);
  });

  it("judges a hot-swap supervisor by its worker, recorded or not", () => {
    const old = { startedAt: installedAt - 1000 };
    const rows = [
      row(20, BREW, old),
      row(21, `${BREW} serve --worker`, { ...old, ppid: 20 }),
      row(30, BREW, old),
      row(31, `${BREW} serve --worker`, { ...old, ppid: 30 }),
    ];
    const records = [{ pid: 21, version: "0.46.0", cwd: "/a", startedAt: NOW }];
    expect(staleServers(rows, records, "0.46.0", { uid: 501, installedAt }).map((s) => s.pid)).toEqual([31]);
  });
});
