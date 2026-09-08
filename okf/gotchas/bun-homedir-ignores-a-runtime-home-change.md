---
type: Gotcha
title: Bun's os.homedir() ignores a runtime HOME change, so HOME-based test isolation is a no-op
description: A beforeAll that redirects HOME reads as a guard and protects nothing under `bun test` — the suite writes into the developer's real home while every assertion passes.
tags: [testing, bun, setup, hooks]
resource: ../src/commands/setup.ts#defaultClaudeSettingsPath
sources:
  - resource: ../tests/commands/setup-home-safety.test.ts
    title: The regression test that keeps a sentinel settings file and asserts it survives
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-08T00:00:00Z }
---

# Symptom

A full `bun test` run installs real hooks into the developer's own
`~/.claude/settings.json`. No test fails. Nothing is printed. The only way it surfaces is
noticing that a feature is configured on your machine when you never ran the command that
configures it, then matching the file's mtime against the test run.

# Why

Two independent causes have to line up, which is why it survived review.

The first is ordinary: the hook installers resolve `~/.claude/settings.json` at call
time, and 27 of the `runSetup` calls in the suite pass no explicit path. The routing
installer had carried that same default for a long time without incident, because it
returns early when routing consent is absent — the hazard was there, just never reached.
The worktree installer is deliberately ungated from that consent, which is the correct
product decision, and it is what turned a latent leak into one that fires every run.

The second is the trap. The obvious fix is to redirect `HOME` in a `beforeAll`. It does
not work:

    bun  -e 'process.env.HOME="/tmp/x"; require("os").homedir()'   ->  /Users/you
    node -e 'process.env.HOME="/tmp/x"; require("os").homedir()'   ->  /tmp/x

Bun's `os.homedir()` ignores a runtime `HOME` change; node's honours it. So the guard
reads exactly like protection, passes review, and protects nothing.

# Fix

Resolve the path through an env seam the test can actually set, and never through `HOME`:

```ts
function defaultClaudeSettingsPath(): string {
  return process.env.BRAIN_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}
```

Any test touching a real user path gets a sentinel: write a known value into the path that
must not change, run the code, assert the sentinel survived. Asserting that the *intended*
path was written is not the same check and does not catch this.

# Where else this bites

Anywhere in this codebase a comment claims HOME can be overridden by a test. One such
comment already existed in `src/commands/resolve-project.ts`, on the exclusion that stops
the upward walk claiming `$HOME` as a project root: "computed per call so a test or
subprocess overriding HOME is seen". True under node. False under `bun test`. A
subprocess still sees it, because that is a fresh process reading the environment it was
given; only an in-process override is ignored.

# How it was found

Checking whether `setup` had ever run against the real settings file, as part of listing
what remained before a release. `rg -c worktree-hook ~/.claude/settings.json` returned 2
when the expected answer was zero, and `stat -f %Sm` on that file matched the minute the
full suite had run.
