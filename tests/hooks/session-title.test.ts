import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  MAX_TITLE_WORDS,
  TITLE_FILE,
  normalizeTitle,
  currentCustomTitle,
  titleRecord,
  decideSessionTitle,
  applySessionTitle,
  buildTitleNotice,
} from "../../src/hooks/session-title.js";
import {
  upsertSessionTitleHook,
  removeSessionTitleHook,
} from "../../src/hooks/claude-settings.js";

describe("normalizeTitle", () => {
  it("collapses every run of whitespace, tabs and newlines included", () => {
    expect(normalizeTitle("  Chrome \t DevTools\n over Playwright  ")).toBe(
      "Chrome DevTools over Playwright",
    );
  });

  it(`caps the name at ${MAX_TITLE_WORDS} words`, () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(normalizeTitle(long)?.split(" ")).toHaveLength(MAX_TITLE_WORDS);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle("   \n ")).toBeNull();
  });
});

describe("currentCustomTitle", () => {
  it("returns the last custom-title record, not the first", () => {
    const transcript = [
      '{"type":"custom-title","customTitle":"old name","sessionId":"s1"}',
      '{"type":"ai-title","aiTitle":"derived name","sessionId":"s1"}',
      '{"type":"custom-title","customTitle":"new name","sessionId":"s1"}',
    ].join("\n");
    expect(currentCustomTitle(transcript)).toBe("new name");
  });

  it("ignores ai-title, which the app falls back to on its own", () => {
    expect(
      currentCustomTitle('{"type":"ai-title","aiTitle":"derived","sessionId":"s1"}'),
    ).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(currentCustomTitle("")).toBeNull();
  });
});

describe("titleRecord", () => {
  it("writes the record shape the app reads back", () => {
    const line = titleRecord("s1", "Chrome DevTools over Playwright");
    expect(JSON.parse(line)).toEqual({
      type: "custom-title",
      customTitle: "Chrome DevTools over Playwright",
      sessionId: "s1",
    });
  });
});

describe("decideSessionTitle", () => {
  const payload = {
    session_id: "s1",
    transcript_path: "/t/s1.jsonl",
    scratchpad_dir: "/scratch",
  };
  const read = (name: string | null, transcript = "") => ({
    name: () => name,
    transcript: () => transcript,
  });

  it("returns the record when the agent named the session", () => {
    const decision = decideSessionTitle(payload, read("Chrome DevTools over Playwright"));
    expect(decision?.transcriptPath).toBe("/t/s1.jsonl");
    expect(JSON.parse(decision!.line).customTitle).toBe("Chrome DevTools over Playwright");
  });

  it("stays quiet when the agent has not named the session", () => {
    expect(decideSessionTitle(payload, read(null))).toBeNull();
  });

  it("stays quiet when the name already is the current title", () => {
    const transcript = '{"type":"custom-title","customTitle":"same name","sessionId":"s1"}';
    expect(decideSessionTitle(payload, read("same name", transcript))).toBeNull();
  });

  it("renames when the name changed, because the work moved on", () => {
    const transcript = '{"type":"custom-title","customTitle":"old name","sessionId":"s1"}';
    expect(decideSessionTitle(payload, read("new name", transcript))).not.toBeNull();
  });

  it.each([
    ["session_id", { ...payload, session_id: "" }],
    ["transcript_path", { ...payload, transcript_path: "" }],
    ["scratchpad_dir", { ...payload, scratchpad_dir: "" }],
  ])("stays quiet when the payload has no %s", (_field, broken) => {
    expect(decideSessionTitle(broken, read("a name"))).toBeNull();
  });

  it("stays quiet on a payload that is not an object", () => {
    expect(decideSessionTitle(null, read("a name"))).toBeNull();
    expect(decideSessionTitle("nope", read("a name"))).toBeNull();
  });
});

describe("applySessionTitle", () => {
  let dir: string;
  let scratch: string;
  let transcript: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-session-title-"));
    scratch = join(dir, "scratch");
    transcript = join(dir, "s1.jsonl");
    await mkdir(scratch, { recursive: true });
    await writeFile(transcript, '{"type":"ai-title","aiTitle":"derived","sessionId":"s1"}\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const payload = () => ({
    session_id: "s1",
    transcript_path: transcript,
    scratchpad_dir: scratch,
  });

  it("appends the record when the agent wrote a name", async () => {
    await writeFile(join(scratch, TITLE_FILE), "Chrome DevTools over Playwright\n");
    await applySessionTitle(payload());

    const lines = (await readFile(transcript, "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      type: "custom-title",
      customTitle: "Chrome DevTools over Playwright",
      sessionId: "s1",
    });
  });

  it("leaves the transcript untouched when there is no name file", async () => {
    const before = await readFile(transcript, "utf8");
    await applySessionTitle(payload());
    expect(await readFile(transcript, "utf8")).toBe(before);
  });

  it("does not append the same title twice", async () => {
    await writeFile(join(scratch, TITLE_FILE), "Same name\n");
    await applySessionTitle(payload());
    await applySessionTitle(payload());

    const lines = (await readFile(transcript, "utf8")).trim().split("\n");
    expect(lines.filter((l) => l.includes('"custom-title"'))).toHaveLength(1);
  });

  it("never throws when the transcript path is unwritable", async () => {
    await writeFile(join(scratch, TITLE_FILE), "A name");
    await expect(
      applySessionTitle({ ...payload(), transcript_path: join(dir, "no", "such", "s.jsonl") }),
    ).resolves.toBeUndefined();
  });
});

describe("buildTitleNotice", () => {
  it("is a SessionStart payload naming the file and the word cap", () => {
    const parsed = JSON.parse(buildTitleNotice()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(TITLE_FILE);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(String(MAX_TITLE_WORDS));
  });
});

describe("upsertSessionTitleHook", () => {
  const commands = (settings: object, event: string) =>
    ((settings as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks[event] ?? [])
      .flatMap((g) => g.hooks)
      .map((h) => h.command);

  it("wires the notice to SessionStart and the apply to Stop", () => {
    const settings = upsertSessionTitleHook(null);
    expect(commands(settings, "SessionStart")).toContain("project-brain session-title notice");
    expect(commands(settings, "Stop")).toContain("project-brain session-title apply");
  });

  it("is idempotent, so a second setup does not double the hook", () => {
    const once = upsertSessionTitleHook(null);
    const twice = upsertSessionTitleHook(once);
    expect(commands(twice, "Stop")).toEqual(commands(once, "Stop"));
    expect(commands(twice, "SessionStart")).toEqual(commands(once, "SessionStart"));
  });

  it("leaves unrelated settings and hooks alone", () => {
    const existing = {
      permissions: { allow: ["Bash(git *)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    };
    const settings = upsertSessionTitleHook(existing) as { permissions: unknown };
    expect(settings.permissions).toEqual(existing.permissions);
    expect(commands(settings, "Stop")).toContain("other-tool");
  });

  it("removes exactly what it added", () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    };
    const stripped = removeSessionTitleHook(upsertSessionTitleHook(existing));
    expect(commands(stripped, "Stop")).toEqual(["other-tool"]);
    expect(commands(stripped, "SessionStart")).toEqual([]);
  });
});
