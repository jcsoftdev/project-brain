import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSyncStatus,
  writeSyncStatusSync,
  readSyncStatus,
  syncStatusPath,
  formatSkipMessage,
  formatLastSyncLine,
  SYNC_LOG_RELATIVE_PATH,
  type SyncStatusRecord,
} from "../../src/commands/sync-status.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-sync-status-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeSyncStatus / readSyncStatus", () => {
  it("round-trips a running record", async () => {
    const record: SyncStatusRecord = {
      outcome: "running",
      pid: 4242,
      startedAt: 1000,
      changedOnly: true,
    };
    await writeSyncStatus(root, record);

    const report = await readSyncStatus(root, () => true);
    expect(report?.outcome).toBe("running");
    expect(report?.pid).toBe(4242);
    expect(report?.startedAt).toBe(1000);
  });

  it("creates .project-brain when it does not exist yet", async () => {
    await writeSyncStatus(root, { outcome: "running", pid: 1, startedAt: 0, changedOnly: false });
    expect(existsSync(syncStatusPath(root))).toBe(true);
  });

  it("round-trips an ok record with files/chunks/finishedAt", async () => {
    await writeSyncStatus(root, {
      outcome: "ok",
      pid: 1,
      startedAt: 1000,
      finishedAt: 5000,
      files: 120,
      chunks: 3400,
      changedOnly: false,
    });

    const report = await readSyncStatus(root, () => true);
    expect(report?.outcome).toBe("ok");
    expect(report?.files).toBe(120);
    expect(report?.chunks).toBe(3400);
    expect(report?.finishedAt).toBe(5000);
  });

  it("round-trips an aborted record with an error message", async () => {
    await writeSyncStatus(root, {
      outcome: "aborted",
      pid: 1,
      startedAt: 0,
      finishedAt: 1_800_000,
      error: "wedged",
      changedOnly: true,
    });

    const report = await readSyncStatus(root, () => true);
    expect(report?.outcome).toBe("aborted");
    expect(report?.error).toBe("wedged");
  });

  it("returns null when no status file exists", async () => {
    expect(await readSyncStatus(root)).toBeNull();
  });

  it("returns null for an unparseable file left by a crash mid-write", async () => {
    mkdirSync(join(root, ".project-brain"), { recursive: true });
    writeFileSync(syncStatusPath(root), "{ truncated");

    expect(await readSyncStatus(root)).toBeNull();
  });

  it("reports a running status whose pid is dead as crashed", async () => {
    await writeSyncStatus(root, { outcome: "running", pid: 999, startedAt: 0, changedOnly: false });

    const report = await readSyncStatus(root, () => false);
    expect(report?.outcome).toBe("crashed");
  });

  it("does not relabel a terminal outcome even when the pid is dead", async () => {
    await writeSyncStatus(root, {
      outcome: "ok",
      pid: 999,
      startedAt: 0,
      finishedAt: 10,
      files: 1,
      chunks: 1,
      changedOnly: false,
    });

    const report = await readSyncStatus(root, () => false);
    expect(report?.outcome).toBe("ok");
  });

  it("never throws when the status directory cannot be created", async () => {
    // Block .project-brain from ever becoming a directory by pre-creating a
    // FILE at that path — mkdir(..., {recursive:true}) then fails with ENOTDIR.
    writeFileSync(join(root, ".project-brain"), "not a directory");

    await expect(
      writeSyncStatus(root, { outcome: "failed", pid: 1, startedAt: 0, changedOnly: false })
    ).resolves.toBeUndefined();
  });
});

describe("writeSyncStatusSync", () => {
  it("writes synchronously so a process can call it right before process.exit", () => {
    writeSyncStatusSync(root, {
      outcome: "aborted",
      pid: 55,
      startedAt: 0,
      finishedAt: 1_800_000,
      error: "sync: aborting after 1800s",
      changedOnly: false,
    });

    const raw = readFileSync(syncStatusPath(root), "utf-8");
    expect(JSON.parse(raw).outcome).toBe("aborted");
  });

  it("never throws when the status directory cannot be created", () => {
    writeFileSync(join(root, ".project-brain"), "not a directory");

    expect(() =>
      writeSyncStatusSync(root, { outcome: "failed", pid: 1, startedAt: 0, changedOnly: false })
    ).not.toThrow();
  });
});

describe("formatSkipMessage", () => {
  it("names the holder pid, its age, and the log location", () => {
    const now = 5 * 60_000; // 5 minutes since epoch, for a deterministic "ago"
    const msg = formatSkipMessage("edumodules", { pid: 14982, at: 60_000 }, now);

    expect(msg).toContain("edumodules");
    expect(msg).toContain("14982");
    expect(msg).toContain("4m ago");
    expect(msg).toContain(SYNC_LOG_RELATIVE_PATH);
    expect(msg).toContain("skipping this one");
  });

  it("falls back to a plain message when the holder record is unavailable", () => {
    const msg = formatSkipMessage("edumodules", null, Date.now());

    expect(msg).toContain("edumodules");
    expect(msg).toContain("skipping this one");
    expect(msg).not.toContain("pid");
  });
});

describe("formatLastSyncLine", () => {
  it("formats a successful sync", () => {
    const line = formatLastSyncLine(
      { outcome: "ok", pid: 1, startedAt: 0, finishedAt: 5_000, files: 120, chunks: 3400, changedOnly: false },
      5 * 60_000 + 5_000
    );
    expect(line).toContain("120 files");
    expect(line).toContain("3400 chunks");
    expect(line).toContain("5m ago");
  });

  it("formats an aborted sync with seconds-precision duration and a log pointer", () => {
    const line = formatLastSyncLine(
      { outcome: "aborted", pid: 1, startedAt: 0, finishedAt: 1_800_000, changedOnly: true },
      1_800_000 + 12 * 60_000
    );
    expect(line).toBe(`aborted after 1800s, 12m ago — see ${SYNC_LOG_RELATIVE_PATH}`);
  });

  it("formats a failed sync with its error and a log pointer", () => {
    const line = formatLastSyncLine(
      { outcome: "failed", pid: 1, startedAt: 0, finishedAt: 1000, error: "ollama unreachable", changedOnly: false },
      1000 + 60_000
    );
    expect(line).toContain("failed");
    expect(line).toContain("ollama unreachable");
    expect(line).toContain(SYNC_LOG_RELATIVE_PATH);
  });

  it("formats a crashed sync naming the dead pid", () => {
    const line = formatLastSyncLine(
      { outcome: "crashed", pid: 4242, startedAt: 0, changedOnly: false },
      60_000
    );
    expect(line).toContain("crashed");
    expect(line).toContain("4242");
    expect(line).toContain(SYNC_LOG_RELATIVE_PATH);
  });

  it("formats a running sync", () => {
    const line = formatLastSyncLine(
      { outcome: "running", pid: 4242, startedAt: 0, changedOnly: false },
      30_000
    );
    expect(line).toContain("running");
    expect(line).toContain("4242");
  });
});
