/**
 * `project-brain browser login` — sign in once on the shared browser's profile.
 *
 * Opens the real Chrome, headed, on the dedicated profile and waits for it to be closed. It
 * never kills anything: if the shared server (or any Chrome) holds the profile, it says so and
 * stops, because Chrome allows one process per profile directory.
 */

import { existsSync, mkdirSync, readlinkSync } from "node:fs";
import { DATA_DIR } from "../constants.js";
import {
  hasChromeProfile,
  loginArgs,
  profileDir,
  profileHolder,
  resolveChromeBinary,
} from "../setup/chrome-profile.js";

export async function execute(args: string[], dataDir: string = DATA_DIR): Promise<void> {
  if (args[0] !== "login") {
    console.error("Usage: project-brain browser login");
    process.exit(1);
  }

  const binary = resolveChromeBinary({
    platform: process.platform,
    exists: existsSync,
    which: (name) => Bun.which(name),
  });
  if (!binary) {
    console.error("Chrome was not found (macOS: /Applications/Google Chrome.app; Linux: google-chrome or chromium on PATH).");
    process.exit(1);
  }

  const dir = profileDir(dataDir);
  const holder = profileHolder(dir, {
    readLock: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  });
  if (holder !== null) {
    console.error(
      `Chrome process ${holder} already holds ${dir}. Stop the shared chrome-devtools server ` +
        `(or close that browser) first, then run this again. Nothing was killed.`
    );
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  console.log(`Opening Chrome on ${dir}. Sign in to what the agent needs, then close the window.`);
  await Bun.spawn([binary, ...loginArgs(dir)], { stdout: "ignore", stderr: "ignore" }).exited;

  const used = await hasChromeProfile(dir, async (p) => existsSync(p));
  console.log(
    used
      ? "Profile saved. Restart the shared server so it reuses it."
      : "Chrome closed before it created a profile; nothing was saved."
  );
}
