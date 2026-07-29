---
type: Constraint
title: A regression guard must be seen failing before it is trusted
description: Write the guard, break the fix on purpose, watch it go red — a green test proves nothing on its own.
tags: [testing, process]
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Constraint

When a test is added to guard a specific bug, the fix must be disabled on purpose
and the guard watched failing, before the work is called done.

# Why

A guard that has only ever been green is an assertion about nothing. It may be
testing a coincidence, a default, or the wrong layer entirely — and it will keep
passing when the bug comes back.

This is not hypothetical here. The guard for
[concepts keyed by repo path](/decisions/concepts-keyed-by-repo-path.md) was
verified by removing the routing: two of five tests went red, and **one of the
remaining three passed anyway**. It asserted that bundle chunks land in the `okf`
module — but the bundle sits in a directory literally named `okf`, so the
indexer's own `module = path.split("/")[0]` produces `okf` by coincidence. That
assertion would have reported success with the bug fully present.

The tests that actually caught it asserted on chunk **content**: that the type
label added by the projection is there, that raw frontmatter delimiters are not,
that the machine-managed block was stripped.

# How to apply

1. Write the guard and get it green.
2. Revert or disable the fix — not the test.
3. Confirm the guard fails, and read *which* assertions failed.
4. Any assertion that stayed green is suspect: it is passing for a reason
   unrelated to the bug. Strengthen it or delete it.
5. Restore the fix and confirm green again.

The same failure mode bit the worker-candidate fallback from the other side: a
guard pinned to one runtime behaviour kept passing while the thing it guarded
stopped working. See
[new Worker() can throw synchronously](/gotchas/worker-constructor-throws.md).
