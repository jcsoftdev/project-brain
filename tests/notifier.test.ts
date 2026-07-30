import { test, it, expect, describe } from "bun:test";
import { isNewer, checkForUpdate, detectInstallManager, updateCommand } from "../src/notifier.js";

describe("isNewer", () => {
  test("detects a newer minor/major/patch", () => {
    expect(isNewer("0.7.0", "0.6.0")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.6.1", "0.6.0")).toBe(true);
  });
  test("equal or older is not newer", () => {
    expect(isNewer("0.6.0", "0.6.0")).toBe(false);
    expect(isNewer("0.5.9", "0.6.0")).toBe(false);
    expect(isNewer("0.6.0", "0.6.1")).toBe(false);
  });
  test("prerelease of the same base is not treated as newer", () => {
    expect(isNewer("0.6.0-beta.1", "0.6.0")).toBe(false);
  });
  test("garbage input is fail-safe (not newer)", () => {
    expect(isNewer("not-a-version", "0.6.0")).toBe(false);
    expect(isNewer("", "0.6.0")).toBe(false);
  });
});

describe("detectInstallManager", () => {
  test("detects bun from ~/.bun/bin", () => {
    expect(detectInstallManager("/Users/x/.bun/bin/project-brain", {})).toBe("bun");
  });

  test("detects bun from ~/.bun/install/global", () => {
    expect(
      detectInstallManager(
        "/Users/x/.bun/install/global/node_modules/.bin/project-brain",
        {}
      )
    ).toBe("bun");
  });

  test("detects pnpm via PNPM_HOME env prefix", () => {
    expect(
      detectInstallManager("/Users/x/Library/pnpm/project-brain", {
        PNPM_HOME: "/Users/x/Library/pnpm",
      })
    ).toBe("pnpm");
  });

  test("detects pnpm via path segment even without PNPM_HOME", () => {
    expect(
      detectInstallManager("/Users/x/Library/pnpm/project-brain", {})
    ).toBe("pnpm");
  });

  test("detects yarn from .yarn/bin", () => {
    expect(detectInstallManager("/Users/x/.yarn/bin/project-brain", {})).toBe("yarn");
  });

  test("detects yarn from yarn/global", () => {
    expect(
      detectInstallManager("/Users/x/.config/yarn/global/node_modules/.bin/project-brain", {})
    ).toBe("yarn");
  });

  test("defaults to npm for /usr/local/lib/node_modules", () => {
    expect(
      detectInstallManager("/usr/local/lib/node_modules/.bin/project-brain", {})
    ).toBe("npm");
  });

  test("defaults to npm for nvm-style paths", () => {
    expect(
      detectInstallManager(
        "/Users/x/.nvm/versions/node/v20.0.0/bin/project-brain",
        {}
      )
    ).toBe("npm");
  });

  test("handles Windows backslash bun path", () => {
    expect(
      detectInstallManager("C:\\Users\\x\\.bun\\bin\\project-brain.exe", {})
    ).toBe("bun");
  });

  test("handles Windows backslash pnpm path via PNPM_HOME", () => {
    expect(
      detectInstallManager("C:\\Users\\x\\AppData\\pnpm\\project-brain.exe", {
        PNPM_HOME: "C:\\Users\\x\\AppData\\pnpm",
      })
    ).toBe("pnpm");
  });
});

describe("updateCommand", () => {
  test("maps each manager to its update command", () => {
    expect(updateCommand("bun")).toBe("bun add -g project-brain@latest");
    expect(updateCommand("pnpm")).toBe("pnpm add -g project-brain@latest");
    expect(updateCommand("yarn")).toBe("yarn global add project-brain@latest");
    expect(updateCommand("npm")).toBe("npm install -g project-brain@latest");
  });
});

describe("checkForUpdate", () => {
  const baseDeps = () => {
    const warned: string[] = [];
    let refreshed = 0;
    return {
      warned,
      refreshed: () => refreshed,
      deps: {
        currentVersion: "0.6.0",
        now: () => 1_000_000_000,
        readCache: () => null as { checkedAt: number; latest: string } | null,
        warn: (m: string) => warned.push(m),
        refresh: () => { refreshed++; },
        staleMs: 86_400_000,
        optedOut: false,
        updateCmd: "npm install -g project-brain@latest",
      },
    };
  };

  test("warns when cached latest is newer than current", () => {
    const h = baseDeps();
    h.deps.readCache = () => ({ checkedAt: 1_000_000_000, latest: "0.7.0" });
    checkForUpdate(h.deps);
    expect(h.warned.length).toBe(1);
    expect(h.warned[0]).toContain("0.7.0");
    expect(h.warned[0]).toContain("0.6.0");
  });

  test("warn message contains the injected update command", () => {
    const h = baseDeps();
    h.deps.updateCmd = "bun add -g project-brain@latest";
    h.deps.readCache = () => ({ checkedAt: 1_000_000_000, latest: "0.7.0" });
    checkForUpdate(h.deps);
    expect(h.warned[0]).toContain("Run: bun add -g project-brain@latest");
  });

  test("silent when cached latest equals current", () => {
    const h = baseDeps();
    h.deps.readCache = () => ({ checkedAt: 1_000_000_000, latest: "0.6.0" });
    checkForUpdate(h.deps);
    expect(h.warned.length).toBe(0);
  });

  test("refreshes (spawns) when cache missing", () => {
    const h = baseDeps();
    h.deps.readCache = () => null;
    checkForUpdate(h.deps);
    expect(h.refreshed()).toBe(1);
  });

  test("refreshes when cache is stale (> staleMs old)", () => {
    const h = baseDeps();
    h.deps.now = () => 1_000_000_000;
    h.deps.readCache = () => ({ checkedAt: 1_000_000_000 - 86_400_001, latest: "0.6.0" });
    checkForUpdate(h.deps);
    expect(h.refreshed()).toBe(1);
  });

  test("does NOT refresh when cache is fresh", () => {
    const h = baseDeps();
    h.deps.now = () => 1_000_000_000;
    h.deps.readCache = () => ({ checkedAt: 1_000_000_000 - 1000, latest: "0.6.0" });
    checkForUpdate(h.deps);
    expect(h.refreshed()).toBe(0);
  });

  test("opt-out: no warn, no refresh", () => {
    const h = baseDeps();
    h.deps.optedOut = true;
    h.deps.readCache = () => ({ checkedAt: 0, latest: "0.7.0" });
    checkForUpdate(h.deps);
    expect(h.warned.length).toBe(0);
    expect(h.refreshed()).toBe(0);
  });

  test("a throwing readCache is fail-silent (still attempts refresh)", () => {
    const h = baseDeps();
    h.deps.readCache = () => { throw new Error("corrupt cache"); };
    checkForUpdate(h.deps);
    expect(h.warned.length).toBe(0);
    expect(h.refreshed()).toBe(1);
  });
});

/**
 * The fallback used to be `npm` for anything unrecognised, which meant a
 * Homebrew or standalone install was told to run `npm install -g project-brain`.
 * That either fails outright or installs a SECOND copy that shadows the real
 * one — worse than offering no update command at all.
 */
describe("detectInstallManager — non-JS channels", () => {
  it("detects a Homebrew Cellar path", () => {
    expect(detectInstallManager("/opt/homebrew/Cellar/project-brain/0.16.1/bin/project-brain", {}))
      .toBe("homebrew");
  });

  it("detects an Intel-mac Homebrew path", () => {
    expect(detectInstallManager("/usr/local/Cellar/project-brain/0.16.1/bin/project-brain", {}))
      .toBe("homebrew");
  });

  it("detects linuxbrew", () => {
    expect(detectInstallManager("/home/linuxbrew/.linuxbrew/bin/project-brain", {}))
      .toBe("homebrew");
  });

  it("detects a Scoop shim", () => {
    expect(detectInstallManager("C:/Users/me/scoop/apps/project-brain/current/project-brain.exe", {}))
      .toBe("scoop");
  });

  it("reports standalone for a path under no known manager", () => {
    expect(detectInstallManager("/usr/local/bin/project-brain", {})).toBe("standalone");
  });

  it("still detects the JS managers", () => {
    expect(detectInstallManager("/Users/me/.bun/bin/project-brain", {})).toBe("bun");
    expect(detectInstallManager("/Users/me/.yarn/bin/project-brain", {})).toBe("yarn");
    expect(detectInstallManager("/opt/pnpm/project-brain", { PNPM_HOME: "/opt/pnpm" })).toBe("pnpm");
  });

  /** npm must be a positive match now, not a shrug. */
  it("detects npm from a real npm global prefix", () => {
    expect(detectInstallManager("/usr/local/lib/node_modules/.bin/project-brain", {})).toBe("npm");
  });
});

describe("updateCommand — non-JS channels", () => {
  it("uses brew upgrade for homebrew", () => {
    expect(updateCommand("homebrew")).toBe("brew upgrade project-brain");
  });

  it("uses scoop update for scoop", () => {
    expect(updateCommand("scoop")).toBe("scoop update project-brain");
  });

  /** No invented command for a channel we cannot drive. */
  it("returns null for standalone rather than guessing", () => {
    expect(updateCommand("standalone")).toBeNull();
  });
});
