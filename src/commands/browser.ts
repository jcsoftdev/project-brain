/**
 * `project-brain browser login` — sign in once on the shared browser's profile.
 *
 * Opens the real Chrome, headed, on the dedicated profile and waits for it to be closed. It
 * never kills anything: if the shared server (or any Chrome) holds the profile, it says so and
 * stops, because Chrome allows one process per profile directory.
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../constants.js";
import { callBridgeTool } from "../browser/bridge.js";
import { probeSharedServer } from "../browser/probe.js";
import { decidePrune, parseDuration, parsePages, recordSeen, stalePages, type SeenState } from "../browser/pages.js";
import { buildStatus, formatStatus } from "../browser/status.js";
import { homedir } from "node:os";
import { restartCommand, serviceFilePath, serviceKindFor, sharedUrl } from "../setup/chrome-shared-server.js";
import {
  hasChromeProfile,
  loginArgs,
  profileDir,
  profileHolder,
  resolveChromeBinary,
} from "../setup/chrome-profile.js";

export async function execute(args: string[], dataDir: string = DATA_DIR): Promise<void> {
  if (args[0] === "login") return login(dataDir);
  if (args[0] === "prune-pages") return prunePages(args.slice(1), dataDir);
  if (args[0] === "status") return status(args.includes("--json"), dataDir);
  console.error("Usage: project-brain browser login | status [--json] | prune-pages --older-than <dur> [--yes]");
  process.exit(1);
}

/** Read-only: starts nothing, signals nothing, and exits 0 whatever it could not determine. */
async function status(json: boolean, dataDir: string): Promise<void> {
  const profile = profileDir(dataDir);
  const probe = probeSharedServer(dataDir);

  const listed = probe ? await callBridgeTool(sharedUrl(probe.port), "list_pages") : null;
  const kind = serviceKindFor(process.platform);
  const ours = kind !== null && existsSync(serviceFilePath(kind, homedir()));

  const report = buildStatus({
    probe,
    profile,
    profileUsed: await hasChromeProfile(profile, async (p) => existsSync(p)),
    pageCount: listed === null ? null : parsePages(listed).length,
    restartCommand: ours ? restartCommand(kind!) : null,
  });
  console.log(json ? JSON.stringify(report, null, 2) : formatStatus(report).join("\n"));
}

const seenPath = (dataDir: string) => join(dataDir, "browser-pages.json");

function loadSeen(dataDir: string): SeenState {
  try {
    return JSON.parse(readFileSync(seenPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Close pages that have sat in the shared browser longer than `--older-than`. Dry run unless
 * `--yes`. The bridge reports no page age, owner or context, so the age is "first seen by this
 * command", which is a lower bound: a live session's idle page can match, which is why nothing
 * is closed without confirmation, and never on a server that is not the headless-profile one.
 */
async function prunePages(args: string[], dataDir: string): Promise<void> {
  const olderThan = parseDuration(args[args.indexOf("--older-than") + 1] ?? "");
  if (olderThan === null) {
    console.error("Usage: project-brain browser prune-pages --older-than <90s|30m|2h|1d> [--yes]");
    process.exit(1);
  }

  const probe = probeSharedServer(dataDir);
  if (!probe) {
    console.log("No shared chrome-devtools server is running.");
    return;
  }
  const listed = await callBridgeTool(sharedUrl(probe.port), "list_pages");
  if (listed === null) {
    console.log("The bridge did not answer; nothing was changed.");
    return;
  }

  const now = Date.now();
  const pages = parsePages(listed);
  const seen = recordSeen(loadSeen(dataDir), probe.pid, pages, now);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(seenPath(dataDir), JSON.stringify(seen));

  const decision = decidePrune(probe.mode, stalePages(pages, seen, probe.pid, now, olderThan), args.includes("--yes"));
  if (decision.kind === "refuse") {
    console.log(`Not closing anything: ${decision.reason}.`);
    return;
  }
  if (decision.pages.length === 0) {
    console.log("No page has been seen for that long (the selected and newest pages are never listed).");
    return;
  }

  for (const page of decision.pages) {
    if (decision.kind === "dry-run") {
      console.log(`would close ${page.id}: ${page.label}`);
    } else {
      const done = await callBridgeTool(sharedUrl(probe.port), "close_page", { pageId: page.id });
      console.log(`${done === null ? "failed to close" : "closed"} ${page.id}: ${page.label}`);
    }
  }
  if (decision.kind === "dry-run") console.log("Dry run. Add --yes to close these pages.");
}

async function login(dataDir: string): Promise<void> {
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
