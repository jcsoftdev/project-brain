---
type: Decision
title: The coverage backlog skips tests, and nothing else does
description: PageRank ranks test helpers highly, but a helper has no why worth recording — while knowledge about a test is legitimate.
tags: [okf, audit, coverage, testing]
resource: ../src/okf/audit.ts#findCoverageGaps
sources:
  - resource: ../src/okf/audit.ts#looksLikeTest
    title: The path matching this decision describes
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T20:50:00-05:00 }
---

# Decision

The coverage backlog — important code no concept explains, ranked by PageRank —
excludes symbols defined in test files. This is the **only** place tests are
filtered. Anchor resolution and staleness treat a test file like any other.

Test paths are matched on whole path segments (`test`, `tests`, `__tests__`,
`spec`, `specs`) plus filename infixes (`.test.`, `.spec.`, `_test.`, `_spec.`).

# Why exclude them from the backlog

The first audit run against this repo put three test helpers in the top ten:
`spawnCli` and `run` from an integration test, and a fixture builder called
`file`. PageRank ranked them highly for a good reason — every case in the file
calls them — but a test helper has no *why* to record. A backlog led by test
plumbing buries the real gaps and teaches the reader to ignore the list.

# Why the filter stops there

Knowledge *about* a test is legitimate knowledge. This bundle already holds
[mockRejectedValueOnce rejects eagerly](/gotchas/mock-rejected-value-is-eager.md),
which anchors `tests/parser/wasm.test.ts` — a trap that cost real debugging time
and lives nowhere else. Filtering tests out of the anchor checks would have
reported that concept as unanchored, or silently stopped watching it for drift.

Suggesting what to write and checking what is written are different questions.
Only the first one has an opinion about tests. The checking side is described in
[Anchors resolve from the bundle root](/decisions/anchors-resolve-from-the-bundle-root.md),
including the case where a `#fragment` is deliberately left resolved.

# The trap in the path matching

Segments are matched **exactly**, never as substrings. `src/latest/release.ts`
contains the letters `test`, and a substring check would quietly drop it — and
everything like it — from the backlog with nobody the wiser, because a missing
suggestion produces no output to notice. There is a regression guard for exactly
this case; see
[A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md).

# Known rough edge

Trivial accessors still reach the backlog: `get`, `set`, and `key` on a cache
class rank highly and explain nothing. A span-length or accessor heuristic would
cut them, but every version tried also cut legitimate small functions. Left
unfiltered on purpose — a little noise beats silently hiding real gaps.

This document is deliberately anchored to two symbols rather than to
`src/okf/audit.ts` as a whole; see
[Anchor as narrowly as the prose actually explains](/decisions/anchors-resolve-from-the-bundle-root.md).
