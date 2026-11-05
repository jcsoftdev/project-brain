---
name: brain-design-review
description: "Trigger: design review, design audit, visual QA, revisa el diseño, AI slop, polish this UI, audit and fix the design, does this look designed. Audits a rendered UI like a designer, scores it, then fixes the findings one commit each and re-verifies."
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

Use when a live or local UI must be judged on how it looks and feels, and the findings should be fixed. Report-only: use `brain-qa-only`. Whole-product MVP verdict: `mvp-ui-review`. Building new UI: `impeccable`.

## Hard Rules

- Judge the rendered page, never the source. Source is read only in the fix phase.
- Every finding carries a screenshot and a measured value from `evaluate_script`. "Spacing feels off" is not a finding: "gap is 13px, scale is 8/16, use 16" is.
- Browser ladder: `chrome-devtools` first; `claude-in-chrome` only for a session the user said to reuse; never Playwright by default.
- Own the tab you open and close it before finishing. Never type passwords or payment data; on a login wall ask the user to sign in, then continue.
- Non-local targets are read-only: no submit, create or delete.
- Calibrate against the project's own system: `DESIGN.md`, then `:root` tokens and the tailwind or theme config. A departure from a token ranks higher; name the token.
- Fix only on a clean tree and on a branch. One fix, one commit, message by `brain-commit`. Code follows `brain-style`.
- Information on screen must be real data or an honest empty state; fixtures that look real are a finding.

## Decision Gates

| Situation | Action |
|-----------|--------|
| No URL, feature branch | Diff-aware: `git diff <base>...HEAD --name-only`, map files to routes, audit those. Base from `gh pr view`, else the default branch, never assumed |
| No URL, default branch | Detect a dev server through `port_acquire` leases or ask |
| Dirty tree | Ask once: commit, stash, or abort. Prefer a `brain-worktree` when other work is in flight |
| Surface is native (SwiftUI, AppKit) | Render offscreen and read the image. `ImageRenderer` draws AppKit-backed controls as yellow placeholders: say so, do not grade them |
| `impeccable` installed | Run its detector and `audit` as a second opinion; dedupe against your findings |
| Finding is a third-party widget or copy | Defer, do not fix |
| Needs the cause in code | `search_context` / `find_symbol` to reach the component, not grep |

## Execution Steps

1. Classify each surface first: Persuade (landing), Operate (app UI), Read (docs), Experience (showcase). Rules differ; see `references/audit.md`.
2. Capture the system: tokens and `DESIGN.md`, then the rendered one with `references/probes.md` (fonts, colors, heading scale, touch targets).
3. First impression: full-page screenshot, then write what it says, the first three things the eye lands on, one word. Run the Trunk Test (6 questions) per page.
4. Per page: `take_snapshot`, `take_screenshot` at 375, 768, 1440 via `resize_page` or `emulate`, `list_console_messages`, `list_network_requests`, `lighthouse_audit` for a11y and perf. Score the ten categories in `references/audit.md`.
5. Walk 2-3 flows and keep the goodwill meter from `references/audit.md`. Check consistency across pages.
6. Report baseline: Design Score and AI Slop Score (A-F), per-category grades, quick wins (3-5, under 30 minutes each).
7. Triage by impact, then fix loop (`references/fix-loop.md`): locate, smallest CSS-first change, commit, re-render, classify verified, best-effort or reverted.
8. Re-audit affected pages. If a score got worse, say so first.
9. Save pitfalls worth keeping to engram (`mem_save`, topic `design-review/<project>`); a lasting constraint goes to the OKF bundle through `brain-okf`.

## Output Contract

Report in `.design-review/<date>/report.md` (git-excluded, never tracked): scores before and after, findings (id, category, impact, evidence, fix status, commit SHA), before/after screenshot pairs, deferred list, one-line PR summary. Show the key screenshots inline with `Read`. Update `TODOS.md` only if it exists. State what was not covered.

## References

- `references/audit.md` — ten-category checklist, AI-slop list, scoring, goodwill meter, hard rules.
- `references/probes.md` — `evaluate_script` functions for the rendered design system.
- `references/fix-loop.md` — fix, commit, re-test, risk cap.
