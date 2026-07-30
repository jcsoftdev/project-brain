---
type: Gotcha
title: git log -L errors when the range runs past the end of the file
description: The failure is itself the signal you want, so degrade to the whole file instead of reporting "unknown".
tags: [git, audit, staleness]
resource: ../src/git/last-changed.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T20:50:00-05:00 }
---

# Gotcha

`git log -1 --format=%cI -L900,999:src/a.ts` exits non-zero when the file has
fewer than 900 lines:

```
fatal: file src/a.ts has only 5 lines
```

It does not return an empty result — it fails the command. A caller that treats
non-zero as "git cannot answer" reports the anchor's date as unknown.

# Why that is the wrong answer

A concept citing lines that no longer exist is *exactly* the drift the audit is
looking for. The file shrank; the explanation is pointing into thin air. Turning
the sharpest possible signal into "unknown" hides it.

# How to apply

Fall back to the whole file when the ranged query fails:

```ts
if (lines) {
  const ranged = runGit(root, ["log", "-1", "--format=%cI", `-L${lines.start},${lines.end}:${path}`]);
  if (ranged.ok) {
    const at = firstLine(ranged.stdout);
    if (at) return { at, uncommitted };
  }
}
const whole = runGit(root, ["log", "-1", "--format=%cI", "--", path]);
```

The whole-file date is at least as recent as any range in it, so the finding
still fires — just with less precision about which edit caused it.

# Two more shapes of the same output

- With `-L`, `--format=%cI` prints the date **and then a diff**. Take the first
  non-empty line, not the whole stdout.
- An untracked or never-existing path makes `git log -- <path>` exit **zero with
  empty output**. Only `git status` distinguishes "untracked" from "unknown"; see
  [Staleness compares git commit dates](/decisions/staleness-baseline-is-two-dates.md).
