/**
 * The dedicated Chrome profile the shared headless browser runs on.
 *
 * Attaching to the owner's Chrome (`--autoConnect`) makes Chrome ask for approval on every
 * reconnection, with no way to remember the answer
 * (https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session).
 * A browser the server launches itself, on a profile of its own, never asks — and keeps its
 * logins between runs because the profile directory is stable.
 *
 * Signing in happens once, by hand, in a normal headed Chrome opened on that same directory
 * (`project-brain browser login`). It carries no automation flags on purpose: Google refuses
 * sign-in in a browser that announces itself as automated.
 */

import { join } from "node:path";

export const PROFILE_DIRNAME = "chrome-profile";

export const profileDir = (dataDir: string) => join(dataDir, PROFILE_DIRNAME);

/**
 * Whether Chrome ever initialised this profile. Chrome writes `Default/Preferences` on first
 * start, so its absence means nothing has been signed in; its presence does not prove a
 * sign-in, only that the profile has been used.
 */
export async function hasChromeProfile(
  dir: string,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  return exists(join(dir, "Default", "Preferences"));
}

/** Arguments for a normal, headed Chrome on the profile: no remote-debugging or automation flags. */
export function loginArgs(dir: string): string[] {
  return [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check"];
}

export interface BinaryDeps {
  platform: string;
  exists: (path: string) => boolean;
  which: (name: string) => string | null;
}

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** The Chrome executable to open, or null when none is installed. */
export function resolveChromeBinary(deps: BinaryDeps): string | null {
  if (deps.platform === "darwin") return deps.exists(MAC_CHROME) ? MAC_CHROME : null;
  if (deps.platform !== "linux") return null;
  for (const name of LINUX_CANDIDATES) {
    const found = deps.which(name);
    if (found) return found;
  }
  return null;
}

export interface LockDeps {
  /** Target of the `SingletonLock` symlink, or null when there is none. */
  readLock: (path: string) => string | null;
  isAlive: (pid: number) => boolean;
}

/**
 * The pid of the live process holding the profile, or null.
 *
 * Chrome takes `SingletonLock`, a symlink whose target is `<host>-<pid>`. A lock whose pid is
 * gone is a leftover from a crash, and Chrome itself clears it on the next start, so it does not
 * block anyone.
 */
export function profileHolder(dir: string, deps: LockDeps): number | null {
  const target = deps.readLock(join(dir, "SingletonLock"));
  const pid = Number(target?.match(/-(\d+)$/)?.[1]);
  return Number.isInteger(pid) && pid > 0 && deps.isAlive(pid) ? pid : null;
}
