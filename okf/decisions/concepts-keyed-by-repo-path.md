---
type: Decision
title: Concepts are keyed by their real repo path, not a synthetic prefix
description: The bundle is tracked in git, so the regular indexer walks it too — both pipelines must agree on chunk ids.
tags: [okf, indexing, git]
resource: ../src/okf/route.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Decision

An OKF concept is stored under the file's **real repo-relative path**, exactly
the id the regular indexer would use for that file. `module` is pinned to `okf`
regardless of where the bundle lives.

`runSync` asks `routeOkfFile` what a file is *before* chunking it, so bundle
files go through the curated projection instead of being chunked as raw markdown.

# Why

The bundle is tracked in git — that is the entire point of the format — so the
regular indexer walks it like any other markdown. Both pipelines write to the
same table, keyed the same way. The ingest originally used a synthetic
`okf/<bundle-relative-path>` prefix, which broke two different ways:

- With the bundle at `./okf` the ids were **identical**, so whichever pipeline
  ran last replaced the other's chunks. The git hook runs sync on commit, so
  committing the bundle destroyed the curated projection every time — at exactly
  the moment nobody was looking.
- With the bundle anywhere else the prefix invented a path that does not exist,
  and the same content ended up indexed twice under two ids.

Pinning `module` to `okf` matters because the regular indexer derives a module
from the first path segment: a bundle in `docs/knowledge/` would otherwise be
filed under `docs` and lose the "this is curated knowledge" marker.

# Why route in sync rather than only in `okf sync`

The watcher and the git hook then keep the knowledge fresh for free — write a
concept, commit, it is indexed. Skipping the bundle during sync instead would
have left it unindexed for anyone who never ran the explicit command, which is a
silent regression from plain markdown indexing.

Anything inside the bundle that is not an indexable concept — `index.md`,
`log.md`, `references/`, a document missing `type` — is **skipped**, never
allowed to fall through to the raw path, which would re-create the collision
under a directory-derived module.

# Trap in the test for this

With the bundle at the default `./okf`, the directory-derived module is *also*
`okf`. A test asserting only on `module` passes even with the routing removed.
The guard must assert on chunk **content** — see
[A regression guard must be seen failing](/constraints/guards-must-be-seen-failing.md).
