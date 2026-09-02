---
type: Constraint
title: Browser bundle artefacts share the module filename shape and must stay allow-listed
description: steps.md, vitals.md, insights.md, a11y-snapshot.md and final-state.md look like brain-audit modules to the lint; renaming or adding one touches the test and every consumer module at once.
tags: [skills, brain-audit, browser, lint]
resource: ../templates/skills/brain-audit/references/browser.md
sources:
  - resource: ../tests/rules/skills.test.ts#L666
    title: The BROWSER_ARTEFACTS allow-list the cross-reference lint consults
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-02T00:00:00Z }
---

# Constraint

The observation bundle `browser.md` produces is named in five `.md` files —
`steps.md`, `vitals.md`, `insights.md`, `a11y-snapshot.md`, `final-state.md` —
and those names are cited, in backticks, from the `## What browser observation
closes` section of twenty-three other modules. They are **not** modules, but the
reference lint cannot tell: its cross-reference rule treats every backticked
`<name>.md` under `references/` as a module that must ship.

The set of artefact names is therefore frozen in two places that must agree:
the bundle table in `browser.md`, and the `BROWSER_ARTEFACTS` list in the test.
Add an artefact to one without the other and `bun test` goes red with
"cross-references to files that do not ship"; rename one and every consumer
module that cites it has to move in the same change.

# What breaks if it does not hold

- A new `.md` artefact cited from a consumer module before it is allow-listed
  fails the lint for every module that cites it, not just the one being edited,
  and the failure names the consumer, not the missing allow-list entry.
- An artefact removed from the allow-list while still cited leaves the same
  failure behind; an artefact removed from `browser.md` while still allow-listed
  silently lets a stale citation pass.
- `runtime.md` and `performance.md` cite `vitals.md` in prose where a reader
  expects a module name. The allow-list is what keeps that from being a broken
  cross-reference; it does nothing for the reader's confusion.

# Why the names were kept

The design fixed them before the lint existed, all twenty-three consumer
sections were written against them, and the JSON/JSONL artefacts
(`console.jsonl`, `network.jsonl`, `trace.json`) never collide. Renaming to a
non-`.md` extension or a `bundle/` prefix would remove the allow-list and the
ambiguity in one move; it was deferred because it is a twenty-five-file change
with no behavioural payoff. If that rename happens, delete `BROWSER_ARTEFACTS`
in the same commit so the lint goes back to having one source of truth.
