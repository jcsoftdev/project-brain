import { describe, it, expect } from "bun:test";
import {
  isSessionCommand,
  lineage,
  liveChildCount,
  parseDuration,
  parseEtime,
  parseProcessTable,
  selectPrune,
  transcriptDirName,
  type PruneOptions,
  type Session,
} from "../../src/sessions/model.js";

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

describe("parseDuration", () => {
  it.each([
    ["90m", 90 * 60_000],
    ["12h", 12 * HOUR],
    ["2d", 48 * HOUR],
    ["0h", null],
    ["1w", null],
    ["h", null],
  ])("%s", (text, expected) => expect(parseDuration(text)).toBe(expected));
});

describe("parseEtime", () => {
  it.each([
    ["00:09", 9],
    ["11:07", 667],
    ["13:54:41", 50_081],
    ["07-02:36:54", 7 * 86_400 + 2 * 3_600 + 36 * 60 + 54],
    ["garbage", null],
  ])("%s", (text, expected) => expect(parseEtime(text)).toBe(expected));
});

describe("transcriptDirName", () => {
  it.each([
    ["/Users/jc/personal/project-brain", "-Users-jc-personal-project-brain"],
    ["/Users/jc/.supacode/repos", "-Users-jc--supacode-repos"],
    ["/tmp/my dir_1", "-tmp-my-dir-1"],
  ])("%s", (cwd, expected) => expect(transcriptDirName(cwd)).toBe(expected));
});

describe("isSessionCommand", () => {
  it.each([
    ["claude", true],
    ["/Users/u/.local/bin/claude --resume abc --model sonnet", true],
    ["/Users/u/.local/share/claude/versions/2.1.312 --foo", true],
    ["claude bg-pty-host --bg-pty-host /tmp/x.sock", false],
    ["claude bg-spare --bg-spare /tmp/x.sock", false],
    ["/Users/u/.local/bin/claude daemon run --origin transient", false],
    ["/Users/u/.local/bin/claude --chrome-native-host", false],
    ["/opt/homebrew/bin/zsh -c source x && claude-ish /claude/versions/", false],
    ["npm exec context7-mcp", false],
    ["/opt/homebrew/bin/project-brain sessions", false],
  ])("%s", (command, expected) => expect(isSessionCommand(command)).toBe(expected));
});

describe("process table", () => {
  const table = parseProcessTable(
    [
      "  100     1 10-00:00:00 claude",
      "  200   100 10-00:00:00 npm exec context7-mcp",
      "  201   100       00:37 caffeinate -i -t 300",
      "  202   100    05:00:00 /bin/zsh -c bun test",
      "  300     1    01:00:00 bash",
      "  301   300       00:05 bun run src/cli.ts sessions",
    ].join("\n")
  );

  it("counts only children born after the startup window, ignoring caffeinate", () => {
    expect(liveChildCount(table[0], table)).toBe(1);
  });

  it("returns the pid and all its ancestors", () => {
    expect([...lineage(301, table)].sort()).toEqual([1, 300, 301]);
  });
});

describe("selectPrune", () => {
  const session = (over: Partial<Session>): Session => ({
    pid: 10,
    ageSec: 100_000,
    memoryMb: 500,
    cwd: "/p",
    lastActivityMs: NOW - 30 * HOUR,
    liveChildren: 0,
    ...over,
  });
  const opts = (over: Partial<PruneOptions> = {}): PruneOptions => ({
    now: NOW,
    idleMs: 24 * HOUR,
    protectedPids: new Set([999]),
    forceChildren: false,
    includeUnknown: false,
    ...over,
  });
  const closes = (s: Session, o: PruneOptions) => selectPrune([s], o)[0].close;

  it.each<[string, Session, PruneOptions, boolean]>([
    ["idle past threshold", session({}), opts(), true],
    ["idle under threshold", session({ lastActivityMs: NOW - 2 * HOUR }), opts(), false],
    ["exactly at threshold is kept", session({ lastActivityMs: NOW - 24 * HOUR }), opts(), false],
    ["ancestor of this process", session({ pid: 999 }), opts(), false],
    ["ancestor even with every override", session({ pid: 999 }), opts({ forceChildren: true, includeUnknown: true }), false],
    ["live children", session({ liveChildren: 2 }), opts(), false],
    ["live children with --force-children", session({ liveChildren: 2 }), opts({ forceChildren: true }), true],
    ["unknown activity", session({ lastActivityMs: null }), opts(), false],
    ["unknown activity with --include-unknown", session({ lastActivityMs: null }), opts({ includeUnknown: true }), true],
  ])("%s", (_name, s, o, expected) => expect(closes(s, o)).toBe(expected));

  it("never yields a pid that was not discovered as a session", () => {
    const verdicts = selectPrune([session({ pid: 10 })], opts());
    expect(verdicts.map((v) => v.pid)).toEqual([10]);
  });
});
