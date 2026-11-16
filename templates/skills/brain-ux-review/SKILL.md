---
name: brain-ux-review
description: "Trigger: UX review, mejorar la UX, usability audit, rediseña este flujo, revisa esta pantalla, UX research, redesign. Walks real tasks, diagnoses with evidence, redesigns and plans validation."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "1.0"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->

## Activation Contract

Use when the ask is to improve how a product works for its users: navigation, content layout, interaction, error recovery, accessibility, judged by walking real tasks. Visual polish only: `brain-design-review`. Bugs only: `brain-qa-only`. MVP go/no-go across every screen: `mvp-ui-review`.

## Hard Rules

- Walk tasks, not screens. Each task is a user goal written without click paths, walked from a plausible entry point to an observable result, including the wrong-choice and failure paths.
- Every finding names screen, step and state, what the person was trying to do, the observed or expected consequence, and whether you reproduced it.
- Label every major decision with its backing: product observation, product data, external research, WCAG criterion, heuristic, or hypothesis. Cite the original source and say how its context matches ours.
- Never invent data, percentages or test results. An uncertain effect is a testable hypothesis.
- Missing context: state assumptions and continue with what you can inspect. Screenshots only: say which behaviors need a prototype or app access.
- Browser ladder: `chrome-devtools` first; `claude-in-chrome` only for a session the user said to reuse. Non-local targets are read-only; never type passwords. Close the tabs you opened.
- Reuse the product's design system: `DESIGN.md`, `:root` tokens, the component kit. A new component is proposed only for a pattern that repeats.

## Decision Gates

| Situation | Action |
|-----------|--------|
| Scope: whole app | Map roles and areas, pick 3-5 tasks product-wide, one subagent per task with `references/delegation.md`; merge and dedupe |
| Scope: one feature | 3-5 tasks inside it plus its entry and exit points; delegate only when tasks share no state |
| Scope: one screen | Inline; the tasks that pass through it, every state of it |
| Mode: audit | Deliverables 1, 2, 4, 5 |
| Mode: redesign | All five deliverables, with before/after wireframes |
| Mode: implement | Redesign, then apply on a branch (clean tree, `brain-commit`, `brain-style`), re-walk each task from its usual entry point |
| Web and mobile both relevant | Walk both; mobile via `emulate` `375x812x3,mobile,touch` |
| Login you cannot do | Public flows first; ask the user to sign in |
| Code cause needed | `search_context` / `find_symbol`, not grep |

## Execution Steps

1. Fix the context: product and access, users and roles, priority tasks, product goal, design system, scope and mode. Write assumptions for anything missing.
2. Pick 3-5 tasks by frequency, importance and cost of failure (`references/protocol.md`). Write each with user, entry point and success criterion.
3. Walk each task on desktop and mobile when relevant: screens, decisions, state changes, alternate routes, completion signals; screenshot each step.
4. Diagnose each flow on the four levels in `references/protocol.md`: information architecture, interaction, visual composition, accessibility and integration.
5. Back the major findings with the sources in `references/protocol.md`; mark the rest as heuristic or hypothesis.
6. Redesign the priority flows per `references/report.md`: current versus proposed journey, per-screen order, primary action, grouping, mobile, states, components and tokens.
7. Write the validation plan: scenarios that hide the route, success criteria, metrics per flow, and how to get a baseline first.
8. In implement mode, apply, re-walk, and record before/after evidence.

## Output Contract

Report in `.ux-review/<date>/report.md` (git-excluded, never tracked), in the order of `references/report.md`: task map, findings table, proposed flows, validation plan, verification status. Show key screenshots inline with `Read`. State what was checked in the app, what needs user testing and what data is missing.

## References

- `references/protocol.md` — task selection, four-level diagnosis, evidence types, sources.
- `references/report.md` — deliverables, findings table, redesign spec, validation plan, test scenarios.
- `references/delegation.md` — splitting by scope, subagent brief, merge rules.
