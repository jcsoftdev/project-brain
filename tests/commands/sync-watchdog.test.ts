import { describe, it, expect, spyOn } from "bun:test";
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  resolveSyncTimeoutMs,
  startSyncWatchdog,
} from "../../src/commands/sync-watchdog.js";

describe("resolveSyncTimeoutMs", () => {
  it("defaults to 30 minutes when nothing is set", () => {
    expect(resolveSyncTimeoutMs({})).toBe(DEFAULT_SYNC_TIMEOUT_MS);
    expect(DEFAULT_SYNC_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("honours an explicit override", () => {
    expect(resolveSyncTimeoutMs({ BRAIN_SYNC_TIMEOUT_MS: "120000" })).toBe(120_000);
  });

  it("treats 0 as disabled", () => {
    expect(resolveSyncTimeoutMs({ BRAIN_SYNC_TIMEOUT_MS: "0" })).toBe(0);
  });

  it("falls back to the default on a non-numeric value, with a warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveSyncTimeoutMs({ BRAIN_SYNC_TIMEOUT_MS: "soon" })).toBe(DEFAULT_SYNC_TIMEOUT_MS);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the default on a negative value", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveSyncTimeoutMs({ BRAIN_SYNC_TIMEOUT_MS: "-1" })).toBe(DEFAULT_SYNC_TIMEOUT_MS);
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a blank value", () => {
    expect(resolveSyncTimeoutMs({ BRAIN_SYNC_TIMEOUT_MS: "  " })).toBe(DEFAULT_SYNC_TIMEOUT_MS);
  });
});

describe("startSyncWatchdog", () => {
  it("fires onExpire once the budget elapses", () => {
    let fire: (() => void) | null = null;
    let expired = 0;

    startSyncWatchdog({
      timeoutMs: 1000,
      onExpire: () => { expired++; },
      setTimer: (fn) => { fire = fn; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });

    expect(expired).toBe(0);
    fire!();
    expect(expired).toBe(1);
  });

  it("arms the timer for exactly the budget", () => {
    let armedFor = -1;
    startSyncWatchdog({
      timeoutMs: 4321,
      onExpire: () => {},
      setTimer: (_fn, ms) => { armedFor = ms; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });
    expect(armedFor).toBe(4321);
  });

  it("cancel() clears the timer so a finished sync is never killed", () => {
    let cleared = 0;
    const cancel = startSyncWatchdog({
      timeoutMs: 1000,
      onExpire: () => {},
      setTimer: () => 7 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: (t) => { cleared++; expect(t).toBe(7 as any); },
    });

    cancel();
    expect(cleared).toBe(1);
  });

  it("never arms a timer when the budget is disabled", () => {
    let armed = 0;
    const cancel = startSyncWatchdog({
      timeoutMs: 0,
      onExpire: () => {},
      setTimer: () => { armed++; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });

    expect(armed).toBe(0);
    cancel(); // still safe to call
  });
});
