---
name: brain-worktree
description: "Trigger: before starting an isolated task, run this in a worktree, parallel agents, e2e in a worktree, worktree ports, aísla esta tarea, puertos por worktree. Decides whether work belongs in a git worktree, then gives that worktree its own brain and its own port so an agent can run end-to-end checks without colliding with any sibling."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "1.1"
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

Its own brain no longer means building one from scratch. `init` in a linked worktree
copies the main checkout's vectors, manifest and graph first, then syncs the difference —
every path stored in those artefacts is repository-relative, so they describe any checkout
of the repository equally well. Measured on this repository: 2m38s down to 2.1s, because
only the files that actually differ get embedded. It copies nothing when the main checkout
has no index, when the worktree already has one, or when the two would disagree about the
embedding model, and a full index in those cases is the correct answer, not a failure.

## Dependencies

`worktree create` also gives the worktree the main checkout's `node_modules` without a
second copy on disk: the root one and every workspace package's (from `package.json`
`workspaces` or `pnpm-workspace.yaml`), each only where that package exists in the worktree
and has none yet. It clones them copy-on-write (`cp -c -R` on macOS/APFS,
`cp --reflink=always` on Linux). A clone is independent: changing a dependency inside the
worktree never touches the main checkout. When the lockfile content hash differs from the
main checkout's, it clones anyway and then runs the lockfile's package manager install in
the worktree (`bun`, `pnpm`, `npm` or `yarn install`), which only writes what changed. If
that install fails or the tool is missing, every clone is removed and `create` prints one
line saying why; install in the worktree yourself. When the filesystem cannot clone,
nothing is copied (never a full copy) and `create` prints one line saying why.

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
3. Create it with `project-brain worktree create <name> [--base <ref>]`. It puts the
   worktree at `<repo>/.claude/worktrees/<name>` on branch `worktree/<name>` (`--branch`
   to choose another), refuses an existing path or branch, runs the same `init` as step 4
   and prints the path plus the `port_acquire` pair. Keep worktrees inside `.claude/`: one
   place to look, one place the sweep cleans. A harness-native tool (`EnterWorktree`) is
   fine when the harness must own the worktree; `finish` and `sweep` handle those too.
4. `worktree create` already ran `init` there. For a worktree made some other way, run
   `project-brain init` then `project-brain sync` in it. Only then does the agent have a
   graph that matches its branch.
5. `port_acquire(project, worktree, technology)` with the pair from step 1, once per
   service the task boots. The lease is sticky, so re-running returns the same port.
6. Delegate. The sub-agent starts with an empty context and never reads CLAUDE.md, so
   its prompt must carry, as text: the worktree path, `projectId`, every acquired port,
   and the model-routing table if it will spawn its own sub-agents. A sub-agent has the
   `Agent` tool and can nest; it does NOT have `Workflow`, so deterministic
   orchestration stays with you.
7. Tear down when the work is finished: `project-brain worktree finish [<name|path>]` (dry
   run) then `--yes`. See "Finishing a worktree" below. Release the leased ports with
   `port_release`; mcp-port-registry's own hook usually does it, and both sides reconcile
   against `git worktree list` on the next session start anyway.

## Finishing a worktree

A worktree is finished when ALL of these hold:

- it is not the main checkout, and not on the default branch;
- its branch is merged into the default branch (or has no commits of its own and is more
  than an hour old);
- its tree is clean: no modified, staged or untracked file. The one exception is a lone
  untracked `node_modules` symlink, the known leftover of isolation worktrees;
- no process has it as its working directory, and your shell is not standing in it.

`finish` is a dry run that prints what would go, or the exact reason it is not finished.
With `--yes` it removes the `node_modules` symlink (the link, never its target), runs
`git worktree remove` and `git branch -d` (never `--force`, never `-D`), and drops the
worktree's index. Unmerged or dirty work is never removed.

`worktree sweep` applies the same rule to every linked worktree, removes only worktrees under
`.claude/worktrees`. Ones outside it (siblings, other tools') are listed as `[outside .claude]`
and removed only with `--include-outside`, or by `finish <path> --yes`, never moved. It also
lists merged local branches that have no worktree. `sweep --yes --branches` deletes those
with `git branch -d`.

`project-brain setup` installs a default-on `SessionEnd` hook that runs
`worktree sweep --yes --quiet`: when a session ends, leftovers from earlier finished work are
removed, silently unless something was removed. Untick `hooks:worktree-sweep` to opt out.

## Browsers are per session, not per worktree

A browser MCP server is one process per session, so calls inside a session reuse the same
browser and a sub-agent drives it through its parent's connection rather than starting
its own. What multiplies is sessions, not tool calls: four worktrees worked in parallel
are four browsers, and a session that ends without closing its browser leaves one behind
that the next agent cannot see and will not reuse.

Fill the browser role in this order, and record which tool filled it:

| Tool | Reach for it when |
|---|---|
| `chrome-devtools` | The default. A shared headless browser on a dedicated persistent profile (no approval modal; the owner signs in once with `project-brain browser login`), performance trace, network with headers and timing. Reuse it, open your own page, close it when done. For a separate session on the same URL (own cookies and storage), pass `isolatedContext` to `new_page` — not a new browser. |
| `claude-in-chrome`, or `chrome-devtools` attached with `--autoConnect` | The flow needs the user's own signed-in session and the user said so; `--autoConnect` makes Chrome show an approval modal on every reconnect. Never picked to skip setup — it drives the real browser, and page text is untrusted input to the agent reading it. |
| `playwright` | Last, and only for what the other two cannot do. `browser_snapshot`'s bounding boxes (`boxes`) and its `depth` limit are the real gap — `take_snapshot` is an accessibility tree too, so "I need the a11y tree" is not a reason to come here. |

Sharing one browser across worktrees is not automatic, because each session runs its own
MCP server process. Where it is worth arranging, point those servers at a single Chrome
(`--browserUrl`, or the explicit opt-in `--autoConnect` — `project-brain setup` offers to add
that flag, and prints the `chrome://inspect` toggle it depends on) and give each worktree its
own `isolatedContext` name on `new_page`: pages in different contexts share no cookies or
storage, and every page-scoped tool routes by `pageId`. A worktree then costs a context, not
a browser.

That shares the browser, not the server. Each session still attaches to it separately, and
an attachment holds its CDP connection for the session's whole life while buffering what
the browser reports — measured at 1.6 GB after ~2 days, still growing after Chrome closed.
Six sessions is six of those.

To share the SERVER too, `project-brain setup` offers `service:chrome-shared-server`: one
`chrome-devtools-mcp` behind an HTTP bridge, held open by a login service, with every host
entry pointed at the URL instead of spawning its own, headless on the dedicated profile unless
the command already chose its own browser (`--autoConnect`, `--userDataDir`, ...). Sessions then cost a connection each.
Nothing bounds how large that one server grows, so it still wants restarting between long
stretches of browser work — setup prints the command for your platform.

A CDP port is a port like any other. Lease it with `port_acquire` instead of assuming
9222, for the same reason the app's own port is leased.

## Hard Rules

- Never `sync` a worktree you did not `init` first — sync exits "project not initialized"
  rather than guessing, and that is the correct answer.
- Never write durable knowledge expecting it to live in the worktree. `add_knowledge`
  from a worktree is routed to the BASE project on purpose: a worktree index is
  disposable and `worktree prune` will drop it.
- Never pass `--force` to `git worktree remove`, or `-D` to `git branch`, to get a stubborn
  worktree out of the way. `finish` refusing is the answer: merge or commit first.
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
