# Fix loop

Runs only after the report is written and the user has not said report-only.

## Preconditions

- `git status --porcelain` is empty, on a feature branch. Otherwise ask once: commit, stash or abort, and offer a `brain-worktree` first.
- Findings triaged: high, then medium, then polish. Mark as deferred what source cannot fix: third-party widgets, copy the team must supply.

## Per finding

1. **Locate.** `search_context` for the concept, `find_symbol` and `find_callers` for the component. Touch only files the finding needs. Prefer CSS, tokens and class changes over structure.
2. **Target.** For layout or hierarchy fixes where the intent is not obvious, describe the target in words from the captured system (same colors, fonts, radii) and show it next to the screenshot. Skip for a wrong hex or a missing padding.
3. **Fix.** Smallest change that resolves it. No refactor, no unrelated improvement. New code follows `brain-style`: no comments, name things, reuse the existing token or component.
4. **Commit.** `git add` the changed files only. One finding per commit, message in the convention `brain-commit` reads from the log, referencing the finding id.
5. **Re-test.** Re-render the page, take the after screenshot, compare with the before one. `list_console_messages` must be no worse than baseline.
6. **Classify.** verified (re-test confirms, no new errors); best-effort (applied, state could not be reproduced); reverted (regression: `git revert HEAD`, mark deferred).
7. **Regression test.** Only for fixes that change JavaScript behavior (dropdowns, conditional rendering, interaction state). CSS-only fixes get none; re-running the review catches them. Add the test beside the existing ones, never edit existing tests or CI config.

## Self-regulation

Every 5 fixes, and after any revert, compute the risk:

| Event | Risk |
|---|---|
| Revert | +15% |
| Component file touched (tsx, jsx, vue, svelte) | +5% per file |
| Fix after the 10th | +1% each |
| Unrelated file touched | +20% |
| CSS-only file | +0% |

Above 20%: stop, show what is done, ask. Hard cap of 30 fixes.

## Closing

Re-audit affected pages, recompute both scores. Worse than baseline: say so first. Never push or open the PR; hand over the one-line summary: "Design review found N issues, fixed M. Design score X to Y, AI slop score X to Y."
