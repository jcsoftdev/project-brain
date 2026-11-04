import { describe, it, expect } from "bun:test";
import {
  hasChromeProfile,
  loginArgs,
  profileDir,
  profileHolder,
  resolveChromeBinary,
} from "../../src/setup/chrome-profile.js";
import { withHeadlessDefault, argsWithAutoConnect } from "../../src/setup/chrome-autoconnect.js";

describe("login arguments", () => {
  it("open a plain headed Chrome on the profile, with no remote-debugging or automation flags", () => {
    const args = loginArgs("/d/chrome-profile");
    expect(args).toContain("--user-data-dir=/d/chrome-profile");
    expect(args.join(" ")).not.toMatch(/remote-debugging|enable-automation|headless/);
  });
});

describe("profile holder", () => {
  const lock = (target: string | null, alive: number[]) => ({
    readLock: () => target,
    isAlive: (pid: number) => alive.includes(pid),
  });

  it("reports the live process named by the SingletonLock target", () => {
    expect(profileHolder("/p", lock("host.local-4242", [4242]))).toBe(4242);
  });

  it("ignores a lock left by a process that is gone, and a missing or unreadable one", () => {
    expect(profileHolder("/p", lock("host.local-4242", []))).toBeNull();
    expect(profileHolder("/p", lock(null, [4242]))).toBeNull();
    expect(profileHolder("/p", lock("garbage", [1]))).toBeNull();
  });

  it("reads the lock inside the profile directory", () => {
    let read = "";
    profileHolder("/p", { readLock: (path) => ((read = path), null), isAlive: () => true });
    expect(read).toBe("/p/SingletonLock");
  });
});

describe("chrome binary", () => {
  const deps = (over: object) => ({ platform: "linux", exists: () => false, which: () => null, ...over });

  it("uses the macOS app bundle, and null when it is not installed", () => {
    const app = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(resolveChromeBinary(deps({ platform: "darwin", exists: (p: string) => p === app }))).toBe(app);
    expect(resolveChromeBinary(deps({ platform: "darwin" }))).toBeNull();
  });

  it("takes the first Linux candidate on PATH, preferring Chrome over Chromium", () => {
    const which = (n: string) => (n === "chromium" || n === "google-chrome" ? `/usr/bin/${n}` : null);
    expect(resolveChromeBinary(deps({ which }))).toBe("/usr/bin/google-chrome");
    expect(resolveChromeBinary(deps({ which: (n: string) => (n === "chromium" ? "/c" : null) }))).toBe("/c");
    expect(resolveChromeBinary(deps({}))).toBeNull();
    expect(resolveChromeBinary(deps({ platform: "win32" }))).toBeNull();
  });
});

describe("profile initialised check", () => {
  it("looks for Default/Preferences", async () => {
    const seen: string[] = [];
    expect(await hasChromeProfile("/p", async (p) => (seen.push(p), true))).toBe(true);
    expect(seen).toEqual(["/p/Default/Preferences"]);
  });
});

describe("default shared-server command with a dedicated profile", () => {
  const PKG = ["-y", "chrome-devtools-mcp@latest"];
  const dir = profileDir("/d");

  it("is headless on the stable profile", () => {
    expect(dir).toBe("/d/chrome-profile");
    expect(withHeadlessDefault(PKG, dir)).toEqual([...PKG, "--headless", `--userDataDir=${dir}`]);
  });

  it("moves an explicit choice of browser across verbatim", () => {
    for (const flag of ["--userDataDir=/mine", "--isolated", "--autoConnect", "--browserUrl=http://x:9222", "--wsEndpoint=ws://x"]) {
      expect(withHeadlessDefault([...PKG, flag], dir)).toEqual([...PKG, flag]);
    }
  });

  it("keeps an explicit headless answer but still adds the profile", () => {
    expect(withHeadlessDefault([...PKG, "--headless=false"], dir)).toEqual([
      ...PKG,
      "--headless=false",
      `--userDataDir=${dir}`,
    ]);
  });

  it("drops our profile, and only ours, when switching to autoConnect", () => {
    expect(argsWithAutoConnect([...PKG, "--headless", `--userDataDir=${dir}`], dir)).toEqual([...PKG, "--autoConnect"]);
    expect(argsWithAutoConnect([...PKG, "--userDataDir=/mine"], dir)).toEqual([...PKG, "--userDataDir=/mine", "--autoConnect"]);
  });
});
