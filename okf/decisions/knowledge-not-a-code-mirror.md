---
type: Decision
title: The knowledge bundle is not a mirror of the code graph
description: No Symbol concepts, no line ranges, no call edges in markdown — only what the AST cannot hold.
tags: [okf, scope, architecture]
status: stable
generated: { by: "human:jcsoftdev", at: 2026-07-29T00:00:00Z }
---

# Decision

The OKF bundle carries **only** knowledge the code cannot state about itself:
why a decision was made, how a subsystem is meant to be used, which constraint
must keep holding, which trap already cost someone a session.

It does not contain `type: Symbol` concepts, line ranges, call edges, or
generated per-module summaries.

# Why

project-brain already answers *what* and *where* from the AST, through
`find_symbol`, `find_callers`, `find_callees` and `impact`. Markdown that
duplicates that derived graph loses on every axis at once: it goes stale the
moment the code moves, nobody curates 16,000 generated files, and it competes for
retrieval rank with the tool that already answers the question better.

The two systems are complementary, not overlapping:

| | project-brain index | OKF bundle |
|---|---|---|
| origin | derived from the AST | curated by humans |
| coverage | exhaustive | deliberately sparse |
| freshness | always current | rots without care |
| answers | what, where | why, how |

A concept that could be produced by reading the code is not a concept — it is a
cache, and a worse one than the index.

# Consequences

- The machine-managed block inside a concept is **stripped before indexing**. It
  holds derived facts, and indexing it would push code-shaped duplicates into the
  semantic index to compete with the prose that is the point of the bundle.
- Concepts are namespaced under the `okf` module rather than mixed anonymously
  into the code chunks, so a knowledge document can never out-rank the code
  itself on a "where is X" lookup.
- The type vocabulary is knowledge-shaped: `Decision`, `Constraint`, `Gotcha`.
  Types named after code structures are the smell that this decision is being
  eroded.
