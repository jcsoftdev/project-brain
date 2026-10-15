---
type: Decision
title: A pruned MCP server that reappears is never pruned again
description: Claude Code can drop our disabledMcpServers entries without the user doing anything, but we cannot tell that apart from a deliberate /mcp re-enable, so the user's possible choice wins and the server joins the keep list for good.
tags: [mcp, prune, claude-json, setup, concurrency]
resource: ../src/mcpprune/prune.ts#applyPrune
sources:
  - resource: ../src/mcpprune/prune.ts
    title: vanishedFrom and planPrune, which read the manifest against the live disabled lists
status: stable
generated: { by: "human:jcsoftdev", at: 2026-10-15T00:00:00-05:00 }
---

# Decision

`project-brain mcp prune` adds servers a project never uses to that project's `disabledMcpServers` in `~/.claude.json` and records each one in a manifest (`~/.project-brain/mcp-prune.json`). On every later pass it compares the manifest with the live file. An entry that is in the manifest but no longer in the project's list has **vanished**. Every vanished server goes to the permanent `keep` list and is never disabled again by the automatic pass, whatever its usage.

# Why

There are two ways an entry vanishes, and they leave the same trace:

1. The user turned the server back on with `/mcp`, which removes it from `disabledMcpServers`.
2. A running Claude Code session rewrote `~/.claude.json` from the state it held in memory before our write, and our entry went with it. Claude Code writes that file often (project stats, MCP changes, account data), so this is not rare.

Nothing in the file says which one happened. The pruning runs automatically on `setup` and on every upgrade, so getting this wrong in case 1 means a background job silently overriding a choice the user made by hand, every release. Getting it wrong in case 2 only costs the token savings for that one server in that one project. The asymmetry decides it.

# Rejected alternative: re-prune unless the server was used since

The first version (3914c81) treated a vanished entry as a user re-enable only if the server had been called in that repo after the entry's `disabledAt`; otherwise it dropped the entry and let the next pass disable it again. The adversarial review before 0.41 showed the hole: a user who re-enables a server and simply has not called it yet before the next `update` gets it switched off again without being asked, and the test suite asserted exactly that behaviour. Usage after the fact is not evidence of intent. Reverted in 9c9efac.

# What keeps the loss small

Because a stale rewrite now costs a server permanently, the write path works to make it unlikely: it re-reads the file, edits only the target arrays, takes the backup, then compares mtime, size and full content immediately before the atomic rename, retrying once and aborting otherwise. The manifest records entries as `pending` before the write so a crash in between never leaves disables that `--revert` cannot see. If those guards are ever weakened, case 2 becomes common and pruning quietly stops working, because every server ends up on `keep`.

To undo a keep, remove the name from the `keep` list in the manifest.
