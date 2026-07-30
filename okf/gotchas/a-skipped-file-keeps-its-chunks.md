---
type: Gotcha
title: A skipped file keeps its chunks — skipping is not deleting
description: Nothing replaces chunks for a file the indexer never sends to batchReplace, so a routing change orphans whatever was indexed before it.
tags: [okf, sync, indexing, staleness]
resource: ../src/commands/sync.ts#L478-L499
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T21:40:00-05:00 }
---

# Gotcha

`batchReplace(project, sources, chunks)` replaces the chunks of the sources it is
given. A file the indexer decides to **skip** is never in that list — so its
existing chunks are not replaced, and not removed. They simply stay.

Recording the manifest entry does not help. The manifest says "this file is
handled at this hash"; it says nothing about what is in the vector store.

# Why it bites when routing changes

Any rule that starts sending a previously-indexed file down the skip path
orphans everything already indexed for it:

- the OKF router learning to skip `index.md`, `log.md`, and `references/`
- a bundle moving into a directory the router now covers
- a concept losing its `type`, which makes it non-indexable

This repo's own `okf/log.md` was the live case. Indexed as ordinary markdown
before the routing existed, it kept `symbol_kind: "section"` chunks named after
its date headings, so a changelog kept surfacing in searches as though it were
knowledge. Every sync afterwards took the skip branch and left it alone.

# Why the manifest hides it

Two short-circuits run before the routing decision: unchanged mtime, then
unchanged content hash. On a normal sync the file never reaches the router at
all, so the orphan is invisible. It is only reachable when the file genuinely
changes — which is also why deleting there costs nothing.

# How to apply

Delete on the skip path, before the manifest write:

```ts
if (okfRoute.skip) {
  await store.deleteBySource(projectId, relPath);
  manifestStore.upsertFile(relPath, hash, mtime, {});
  return "skipped" as const;
}
```

Order matters. A failed delete followed by a recorded manifest entry means the
orphan is now marked as handled and never revisited; delete first and a failure
retries on the next run.

# The shape to watch for

The same class of bug produced stale structural rows in `graph.db`: a deletion
sweep that iterates manifest paths cannot see rows the manifest no longer covers.
Whenever a pipeline decides "do nothing for this file", ask what was already
written for it — see
[Concepts are keyed by their real repo path](/decisions/concepts-keyed-by-repo-path.md)
for why both pipelines writing the same keys makes this sharper than it looks.
