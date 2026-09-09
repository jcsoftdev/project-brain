---
type: Gotcha
title: The rescue pass resets the circuit breaker, so a backend that is down reads as one that is slow
description: A dead Ollama turned every commit into a four-hour sync; the machine ran out of swap and macOS killed unrelated dev servers.
tags: [embeddings, sync, retries, resource-exhaustion]
resource: ../src/embeddings/rescue.ts#rescueEmbedPass
sources:
  - resource: ../src/embeddings/ollama.ts#embed
    title: The circuit breaker the rescue pass deliberately bypasses
  - resource: ../src/hooks/git.ts#installGitHook
    title: Spawns one detached sync per commit, which is how the cost multiplied
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-08T00:00:00-05:00 }
---

# Symptom

Nothing points at project-brain. A Node API server and an Angular dev server die
mid-session with a generic low-memory message, twice. The obvious suspects are a
port conflict or the app being worked on.

The machine had 45 project-brain processes holding 12.13 GB resident, 31 of them
`sync --changed-only`, the oldest 3h 59m old, and 0.97 GB of swap left. Under
that, any newly spawned process is a candidate for the OS memory killer.

The only way to see it is to ask by name:

```sh
ps -Ao pid,rss,etime,args | rg "[p]roject-brain sync"
```

Any elapsed time past a minute or two is a job that will never finish.

Ask with `ps`, not `pgrep`. On the machine this was found on, `pgrep -fc
"project-brain sync"` answered `0` while `ps` listed nineteen live syncs in the
same second. A false all-clear from the cheaper command is worse than no check
at all: it retires the correct hypothesis and sends you back to hunting port
conflicts.

# Why

The syncs were not hung. They were working, and would have kept working for
hours.

`rescueEmbedPass` is the last rung of the embedding ladder: after the concurrent
pass and the sequential small-batch pass both fail, it retries what is left one
text at a time, three attempts each, with a shared backoff capped at 4s. That
exists for a backend that is **struggling** — a memory-constrained Ollama that
fails a batch it could serve as singles.

To do that it has to call `embeddings.reset?.()` before every retry, because
otherwise the breaker in `OllamaEmbeddingClient` would trip after two
consecutive failures and null out the rest of the pass instantly. That bypass is
correct for its intended case and fatal outside it: **it removes the only
mechanism that could tell "down" apart from "slow"**, so a backend answering
nothing at all gets the identical treatment, forever.

Measured with Ollama stopped: ~4.5s per request, three requests per chunk, about
13.6s per chunk. One pass over a thousand chunks is roughly four hours — which
is exactly the age of the oldest stuck job. All of it holding the run's buffers
resident, 300 to 700 MB apiece.

Then the post-commit hook multiplied it. It spawns
`{ project-brain sync --changed-only && project-brain conceptualize; } &`,
detached, once per commit, and nothing anywhere held a lock. Every commit landed
during a doomed four-hour run started another one beside it.

# Fix

Three changes, because the grind, the unbounded job, and the stacking are three
different faults:

- `rescueEmbedPass` abandons the pass after `MAX_CONSECUTIVE_FAILED_CHUNKS`
  chunks in a row exhaust every attempt. Any success clears the streak, so a
  single poisoned chunk between healthy neighbours still fails alone and the
  pass continues — the behaviour the rung was built for.
- `startSyncWatchdog` puts a wall-clock budget on a CLI sync (30 min,
  `BRAIN_SYNC_TIMEOUT_MS`), armed before the model auto-pull, which has no
  timeout of its own.
- `acquireSyncLock` makes a project's sync single-flight through
  `.project-brain/sync.lock`. A second run skips rather than queues, because the
  holder is about to index the same working tree.

The watchdog exits without unwinding and leaves the lock file behind on purpose.
The next run finds a dead pid in it and reclaims it, which is more reliable than
asking a process already declared wedged to finish an async cleanup first.

Upgrading does not end an incident already in progress. The runs are detached
children of the binary that spawned them, so syncs started by the old version
keep grinding with the old code — no watchdog, no lock, no failure streak —
across the install. Clear them by hand once, after upgrading:

```sh
pkill -f "project-brain sync --changed-only"
```

Only the `sync --changed-only` children. The long-lived
`/opt/homebrew/bin/project-brain` MCP servers are not part of this and must be
left alone.

And the fix bounds the damage, it does not remove the cause. With the backend
still down, every sync now stops at the watchdog's budget instead of running for
four hours, which keeps the machine alive but indexes nothing. Check the backend
itself before concluding the incident is over:

```sh
curl --max-time 3 http://localhost:11434/api/tags
```

# How it was found

The report described leaked processes, so the first instinct was a handle leak —
a sync that finishes and never exits. `src/cli.ts` even documents that exact bug
for `search`, which needs an explicit `process.exit(0)` because a hung Ollama
call outlives its own race. That made it a tempting answer, and it was the wrong
one.

What settled it was running one sync with the backend down and timing it, rather
than reasoning about it:

```sh
project-brain sync --changed-only   # Ollama stopped
```

Counting `attempt 1/3` lines in the output over a minute gave 13.6s per chunk.
Multiplying by the chunk count in the pass's own log line reproduced the
four-hour figure from the report, and no handle-leak theory was needed to
explain anything.

The lesson generalises past this pass: **a retry policy that suppresses its own
failure detector needs its own stopping condition**, or it inherits none. Measure
the per-item cost of the degraded path and multiply by the worst-case item count
before deciding a retry ladder is bounded.
