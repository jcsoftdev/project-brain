---
name: brain-worktree
description: "Trigger: before starting an isolated task, run this in a worktree, parallel agents, e2e in a worktree, worktree ports, aísla esta tarea, puertos por worktree. Decides whether work belongs in a git worktree, then gives that worktree its own brain and its own port so an agent can run end-to-end checks without colliding with any sibling."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "1.0"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->

## Activation Contract

Apply before delegating a task that will change code AND be checked by running the app:
an end-to-end pass, a browser walkthrough, a recorded demo, anything that needs a server
listening on a port.

Do not apply to read-only questions, to work that never boots the app, or when the
session is already inside a worktree that `worktree status` reports as indexed.

## Why a worktree needs its own brain

project-brain resolves a project by walking UP from the current directory to the nearest
`.project-brain/`. Worktrees are created *inside* the main checkout, so an uninitialized
worktree used to resolve to the main checkout and answer every structural query from
main's graph while the caller sat on a different branch. Wrong answers, no warning.

Two guards close that now: the upward walk stops at a linked worktree's own toplevel, and
the MCP server refuses to boot in an uninitialized worktree instead of minting an empty
graph there. Both turn a silent lie into a message that names the fix. Your job is to run
the fix before the agent hits it.

## The one identifier rule

`project-brain worktree status --json` returns both spellings. They are not
interchangeable:

| Field | Goes to | Note |
|---|---|---|
| `project` + `worktree` | `port_acquire`, `port_release` | lowercased; the pair mcp-port-registry leases on |
| `projectId` | every project-brain MCP tool | project-brain's own casing, suffixed `@<worktree>` |

Pass `projectId` where `project` belongs and the port registry leases a port for a
worktree nobody indexed. The two halves drift apart and nothing errors.

## Execution Steps

1. Run `project-brain worktree status --json`. If `isMain` is false and `indexed` is
   true, the worktree is ready — skip to step 5. A session that started inside a
   worktree already has this in context: the `SessionStart` hook injects it, and says
   nothing at all in a main checkout.
2. Decide isolation. Needed when the task changes code and something else must keep
   running on the current branch, or when sibling agents work in parallel. Not needed for
   a read-only task. Ask before creating one unless the user already said to.
3. Create it with the harness's own tool (`EnterWorktree`, or the `using-git-worktrees`
   skill). Never `git worktree add` by hand when a native tool exists — the harness
   cannot see or clean up what it did not create.
4. In the worktree: `project-brain init` then `project-brain sync`. Only now does the
   agent have a graph that matches its branch.
5. `port_acquire(project, worktree, technology)` with the pair from step 1, once per
   service the task boots. The lease is sticky, so re-running returns the same port.
6. Delegate. The sub-agent starts with an empty context and never reads CLAUDE.md, so
   its prompt must carry, as text: the worktree path, `projectId`, every acquired port,
   and the model-routing table if it will spawn its own sub-agents. A sub-agent has the
   `Agent` tool and can nest; it does NOT have `Workflow`, so deterministic
   orchestration stays with you.
7. Tear down. `project-brain setup` installs hooks that do this for you: `WorktreeRemove`
   reclaims the worktree's index, and mcp-port-registry's own hook releases its ports.
   Run `project-brain worktree prune` and `port_release` by hand only when you removed a
   worktree outside the harness, or when a non-interactive run skipped hooks entirely.
   Both sides reconcile against `git worktree list` on the next session start anyway,
   which is why neither trusts the removal event alone.

## Browsers are per session, not per worktree

A browser MCP server is one process per session, so calls inside a session reuse the same
browser and a sub-agent drives it through its parent's connection rather than starting
its own. What multiplies is sessions, not tool calls: four worktrees worked in parallel
are four browsers, and a session that ends without closing its browser leaves one behind
that the next agent cannot see and will not reuse.

Fill the browser role in this order, and record which tool filled it:

| Tool | Reach for it when |
|---|---|
| `chrome-devtools` | The default. Isolated profile, headless, performance trace, network with headers and timing. |
| `claude-in-chrome` | The flow needs the user's own signed-in session and the user said so. Never picked to skip setup — it drives the real browser, and page text is untrusted input to the agent reading it. |
| `playwright` | Last, and only for what the other two cannot do. `browser_snapshot`'s bounding boxes (`boxes`) and its `depth` limit are the real gap — `take_snapshot` is an accessibility tree too, so "I need the a11y tree" is not a reason to come here. |

Sharing one browser across worktrees is not automatic, because each session runs its own
MCP server process. Where it is worth arranging, point those servers at a single Chrome
(`--browserUrl`, or `--autoConnect`) and give each worktree its own `isolatedContext`
name on `new_page`: pages in different contexts share no cookies or storage, and every
page-scoped tool routes by `pageId`. A worktree then costs a context, not a browser.

A CDP port is a port like any other. Lease it with `port_acquire` instead of assuming
9222, for the same reason the app's own port is leased.

## Hard Rules

- Never `sync` a worktree you did not `init` first — sync exits "project not initialized"
  rather than guessing, and that is the correct answer.
- Never write durable knowledge expecting it to live in the worktree. `add_knowledge`
  from a worktree is routed to the BASE project on purpose: a worktree index is
  disposable and `worktree prune` will drop it.
- Never run `worktree prune` to fix a confusing result. It reclaims by asking git which
  worktrees are live, with no grace window, because a worktree index is re-derivable by
  one `sync`. That is safe for worktrees and wrong for projects — whole projects belong
  to `prune`, which has the grace window.
- Never leave a browser open when a delegation returns. The browser outlives the
  sub-agent that opened it, and the next agent has no way to find it, so it opens another.
- Never reach for `playwright` first because it is already connected. Being installed is
  not a capability argument, and it is the rung that has to justify itself.
- Never hardcode a port. Two agents that both assume 3000 collide, and the failure looks
  like a broken app rather than a taken port.
- If a delegation from the main checkout is blocked with a message about isolation, that
  is the opt-in `PreToolUse` guard, not a bug. It asks for a decision, not a worktree:
  re-issue with the word `worktree` in the description, either naming the one it runs in
  or saying plainly that the task does not need one. Do not disable the guard to get past
  it.

## Output Contract

Report: the worktree path and branch, its `projectId`, each technology with the port
leased for it, what was delegated and to which model, and whether teardown ran or was
deliberately left open.
