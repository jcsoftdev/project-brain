# QA report

Write to `<report dir>/run-<UTC timestamp>/qa-report-<target>-<date>.md`. `<target>` is the hostname, executable basename or service name, with anything but letters, digits and hyphens replaced by hyphens. Never overwrite an earlier run.

## Template

```markdown
# QA report: <target>

Date, branch and revision, mode, scope, who authorized what, timing and stop reason.

## Charters
One per probe: expected result, risk, entrypoint, isolation, exit condition. Written before probing.

## Summary
Health in a sentence, counts by severity, the three findings that matter most.

## Findings
### QA-001 <title>
- Severity: Blocker | Major | Minor | Polish
- Surface and entrypoint
- Steps to reproduce (numbered, from a clean state)
- Expected / Actual
- Evidence: screenshot path, console or network line, command output, exit code
- Reproduced: N of N runs
- Suspected area: one line, no fix

## Proposed tests
Each with a value card.

## Coverage
Reached, not reached and why, blocked by environment.

## Cleanup
What was created and removed.
```

## Severity

| Level | Meaning |
|---|---|
| Blocker | core flow cannot complete, data loss, security boundary crossed |
| Major | core flow degraded, wrong result, no workaround |
| Minor | wrong but with a workaround, or off the core path |
| Polish | cosmetic or wording |

## Test value bar

Propose a test only when it answers: what it protects, what makes it fail, why existing coverage does not catch it (prefer a row in an existing table-driven test), and whether it needs a production seam that no production caller needs. If it needs one, test at the real boundary instead.

Value card under each proposed test:

`Value: protects=<...>; fails_when=<...>; why_new=<...>; seam=none; no_claim=<what green does not prove>`

Reject with the covering file named: "checkout renders is covered by checkout.e2e.ts:15, extend that test."

## Regression mode

Replay the prior report's reproduction steps. Classify each as fixed, still failing, or new. A missing baseline blocks that surface's regression coverage, not the other checks.

## Consistency check before writing

Every finding has steps, expected versus actual and evidence. Counts in the summary match the findings. Nothing claims an edit was made. Anything not run is marked not run.
