import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedActivityMs } from "../../src/sessions/activity.js";
import { ACTIVE_WINDOW_MS, describeActivity, idleMs, transcriptDirName } from "../../src/sessions/model.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const CWD = "/work/app";
const SESSION_ID = "sess-1";
const roots: string[] = [];

const entry = (type: string, at: number | null) =>
  JSON.stringify({ type, ...(at === null ? {} : { timestamp: new Date(at).toISOString() }) });

interface Fixture {
  updatedAt?: number;
  transcript?: string[];
  touchTranscriptAt?: number;
}

function build({ updatedAt, transcript, touchTranscriptAt }: Fixture): string {
  const claudeDir = mkdtempSync(join(tmpdir(), "pb-sessions-"));
  roots.push(claudeDir);
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  if (updatedAt !== undefined || transcript !== undefined) {
    writeFileSync(join(claudeDir, "sessions", "42.json"), JSON.stringify({ pid: 42, sessionId: SESSION_ID, updatedAt }));
  }
  if (transcript !== undefined) {
    const dir = join(claudeDir, "projects", transcriptDirName(CWD));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, transcript.join("\n") + "\n");
    if (touchTranscriptAt !== undefined) utimesSync(file, touchTranscriptAt / 1000, touchTranscriptAt / 1000);
  }
  return claudeDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const classify = (claudeDir: string) =>
  describeActivity(idleMs({ lastActivityMs: recordedActivityMs(claudeDir, 42, CWD) } as never, NOW));

describe("recorded session activity", () => {
  const cases: [string, Fixture, string][] = [
    [
      "idle session whose transcript file mtime is fresh stays idle (regression)",
      { updatedAt: NOW - 5 * HOUR, transcript: [entry("user", NOW - 5 * HOUR)], touchTranscriptAt: NOW },
      "idle 5h0m",
    ],
    ["recent registry updatedAt is active", { updatedAt: NOW - 2 * MIN }, "active"],
    ["recent last message is active", { updatedAt: NOW - 3 * HOUR, transcript: [entry("assistant", NOW - MIN)] }, "active"],
    [
      "trailing housekeeping entries are ignored",
      {
        updatedAt: NOW - 3 * HOUR,
        transcript: [
          entry("user", NOW - 3 * HOUR),
          entry("system", NOW - MIN),
          entry("attachment", NOW - MIN),
          entry("ai-title", null),
          entry("permission-mode", null),
        ],
      },
      "idle 3h0m",
    ],
    ["at the window edge is idle", { updatedAt: NOW - ACTIVE_WINDOW_MS }, "idle 15m"],
    ["no registry file and no transcript is unknown", {}, "unknown"],
    ["registry without updatedAt and empty transcript is unknown", { transcript: [] }, "unknown"],
  ];

  it.each(cases)("%s", (_name, fixture, expected) => {
    expect(classify(build(fixture))).toBe(expected);
  });

  it("reads the tail of a large transcript", () => {
    const filler = Array.from({ length: 20_000 }, () => entry("user", NOW - 9 * HOUR));
    const claudeDir = build({ transcript: [...filler, entry("assistant", NOW - MIN)] });
    expect(recordedActivityMs(claudeDir, 42, CWD)).toBe(NOW - MIN);
  });
});
