---
type: Decision
title: Anchors resolve from the bundle root, not from the document
description: A resource shares the base OKF already uses for prose links, so a concept can move between subdirectories without rewriting its anchors.
tags: [okf, audit, anchors, conventions]
resource: ../src/okf/anchors.ts
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T20:50:00-05:00 }
---

# Decision

A `resource` path — top-level or inside a `sources[]` entry — is resolved
against the **bundle root**, then re-expressed as a repo-relative POSIX path.
From a bundle at `<repo>/okf`, `../src/parser/wasm.ts` means
`src/parser/wasm.ts` no matter which subdirectory the concept lives in.

Fragments follow the conventions a reader already knows from a code host:

- `path#symbolName` — the span comes from the graph's symbol table
- `path#L10-L25` or `path#L42` — an explicit span

# Why the bundle root

OKF prose links are already root-relative: the spec's own examples and this
bundle's bodies write `/decisions/x.md`, not `../decisions/x.md`. Giving
`resource` a different base than links in the same document is the kind of
inconsistency that gets silently miswritten, and a miswritten anchor produces a
`file not found` finding rather than a crash — easy to shrug at, easy to leave
broken.

Root-relative also survives reorganisation. Moving a concept from `gotchas/` to
`gotchas/parser/` would change every document-relative anchor in it; root-relative
anchors are untouched.

# What is dropped rather than reported

- **URLs** (`https:`, `mailto:`) — legitimate OKF provenance (§5.1), simply not
  anchors into this repo.
- **Paths escaping the repo** — nothing outside it is in the graph, so an
  "unresolved" finding would be noise the author cannot act on.
- **Malformed `sources[]` entries** — §11 forbids rejecting a document over bad
  optional data.
- **Reversed ranges** (`#L25-L10`) — a typo, not a request. Falling through to
  the symbol branch would look up a "symbol" named `L25-L10`, turning a broken
  anchor into a missing one.

# Anchor as narrowly as the prose actually explains

A file-level anchor claims every symbol in the file, and link inference reads
that claim literally: the concept becomes responsible for every outbound call
that file makes. Anchor a 300-line module to explain one function in it and the
audit will propose links to every concept that owns any of that module's
dependencies.

This is not a defect in the inference — it is the inference reporting an
over-broad claim. It happened immediately here. `coverage-backlog-skips-tests`
anchored all of `src/okf/audit.ts` while explaining one filter, and the audit
proposed two links from it, including one to a git gotcha it has nothing to do
with. Narrowing the anchor to `#findCoverageGaps` plus a `sources[]` entry for
`#looksLikeTest` removed both suggestions, because the claim then matched the
prose.

Use a file-level anchor when the concept really is about the whole module; reach
for `#symbol` the moment it is not.

# Where a symbol anchor is NOT called broken

If the graph holds no symbols at all for the anchored file, a `#fragment` is left
resolved. The parser covers a fixed set of languages, so silence means "not
parsed", not "not there" — and a concept anchoring `#Rationale` in a markdown
file must not be reported broken. Calling a live anchor dead is worse than
missing a dead one.
