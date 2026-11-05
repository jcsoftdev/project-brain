---
name: brain-qa-only
description: "Trigger: qa report only, just report bugs, test but don't fix, QA this branch, find bugs without fixing, prueba y reporta, reproduce and document. Explores a browser, API, CLI or worker surface and reports reproducible bugs with evidence; never edits product code."
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

Use when the ask is to find and document bugs, not to fix them. Design judgment: `brain-design-review`. Every screen of a product and an MVP verdict: `mvp-ui-review`. Recording a demo: `brain-record`.

## Hard Rules

- Never edit product code, tests, dependencies or config. No commit, stash, install or push. Writes go only to the report directory and owned fixtures.
- Browser surfaces are black-box: observe behavior, do not read source to explain it. Source and diff reads only map changes to routes and flows.
- Write the charters to the report and wait for the write before the first probe: expected result, risk, entrypoint, isolation, exit condition. The plan is not invented afterwards.
- Reproduce before reporting. A finding without steps, expected versus actual and evidence is a note, not a bug. Rerun a failure once in a clean state before calling it product or environment.
- Isolated synthetic identity and data. Prod or signed-in sessions: no create, submit, send or delete; never ask for passwords in chat.
- Browser ladder: `chrome-devtools` first, `claude-in-chrome` only for a session the user asked to reuse. Close the tabs you opened.
- Never invoke a fixing skill from here. A proposed fix is text in the report.

## Decision Gates

| Surface | Method |
|---------|--------|
| Browser | `new_page`, `take_snapshot`, interact, `list_console_messages`, `list_network_requests`, `take_screenshot` on every failure |
| HTTP API | Real requests against a local instance; assert status, body, headers, idempotency, duplicate delivery |
| CLI / job / worker / webhook | Run the documented command in a `mktemp -d` HOME; capture exit code, stdout, stderr, persisted state |
| Feature branch, no scope | Diff-aware: changed and adjacent behavior |
| `--quick` | Smoke on the critical path only |
| `--regression <report>` | Replay the prior report's steps; classify fixed, still failing, new |
| Port needed | `port_acquire`, never assume 3000 or 9222 |

## Execution Steps

1. Parse target, mode, output dir (default `.qa-reports/`, git-excluded) and scope; ask once if the target is unknown.
2. Gather context: this session's test plan, `TODOS.md`, known failures in engram (`mem_search`); treat them as leads, not proof.
3. Create `run-<UTC timestamp>/` and the report file. Write the charters. Check the documented test command and framework; if none, report the gap and propose cases, install nothing.
4. Probe each charter. Capture per finding: steps, expected, actual, screenshot or log line, console and network evidence, severity (Blocker, Major, Minor, Polish) and a one-line suspected area.
5. Rank the proposed regression tests with the value bar in `references/report.md`; reject duplicates of existing coverage.
6. Write the report from `references/report.md`, check it is consistent with the evidence, and finish.

## Output Contract

Report: charters, health summary, findings table, per-finding repro, proposed tests with value card, coverage not reached and why, cleanup done. Offer the fix as a separate, user-authorized step. Remove scratch you created and say what you removed.

## References

- `references/report.md` — report template, severity scale, test value bar.
