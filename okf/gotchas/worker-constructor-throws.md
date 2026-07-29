---
type: Gotcha
title: new Worker() can throw synchronously instead of firing onerror
description: Candidate fallback in ParserPool must handle both failure modes, or an unresolvable entry aborts indexing entirely.
tags: [parser, bun, workers]
resource: ../src/parser/pool.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Symptom

`new ParserPool(...)` throws and takes down the whole sync, instead of falling
back to the next worker-entry candidate.

# Why

`ParserPool.spawnSlot` tries worker-entry candidates in order so a layout
mismatch — compiled binary vs dev vs Windows — degrades gracefully. The fallback
was wired entirely through `worker.onerror`, which assumes an unresolvable entry
fails *asynchronously*.

Bun 1.2.2 rejects it inside the `new Worker()` constructor instead. The throw
escaped `spawnSlot`, escaped the `ParserPool` constructor, and aborted indexing —
precisely the dead-first-candidate case the fallback exists to survive.

Bun has surfaced this both ways across versions, so neither mode can be assumed.

# Fix

Wrap the construction and treat a synchronous throw exactly like an error event:
record the attempt, move to the next candidate.

```ts
let worker: Worker;
try {
  worker = new Worker(url);
} catch (error) {
  this.attemptLog.push({ url, outcome: "errored", message: String(error) });
  if (!this.disposed) this.spawnSlot(candidates, candidateIndex + 1);
  return;
}
```

# Why the test suite missed it

The supplementary mechanism test pinned only the async path — it asserted that an
unloadable worker *fires onerror*. When the runtime changed modes the assertion
became false for a reason unrelated to our code, and the real regression
(fallback stopped working at all) hid behind it.

It now accepts either failure mode and fails only if a dead candidate becomes
*silently fine* — the one outcome that would leave the pool waiting forever on a
worker that will never load. Pinning one mode of a runtime behaviour you do not
control is how a guard stops guarding.
