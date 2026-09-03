---
type: Gotcha
title: Observation-table severity cells escaped the lint for three batches
description: The layer-1 lint validated only the Severity guidance table, so prose and ranges copied from research briefs landed in the "Observed instance earns" column of 47 modules and passed every test run.
tags: [skills, brain-audit, lint, severity, evidence-contract]
resource: ../tests/rules/skills.test.ts#L755-L770
sources:
  - resource: ../tests/rules/skills.test.ts#L738-L753
    title: The guidance-table check that already existed and gave false confidence
  - resource: ../templates/skills/brain-audit/SKILL.md
    title: The Evidence Contract whose severity vocabulary both tables must use
status: stable
generated: { by: "human:jcsoftdev", at: 2026-09-03T15:10:00Z }
---

# Symptom

`bun test tests/rules/skills.test.ts` was green after every batch of the 2026-09-02 deep-research campaign, and the per-batch task reviewers approved the diffs, yet the "Observed instance earns" column of the `## What browser observation closes` tables carried cells such as:

```
Info to Medium, scaled to what the violated directive protects
Same as the underlying static finding, tier raised from `read` to `observed`
No new row — promotes the existing finding's tier
```

None of those is a severity. An auditor reading the module cannot assign a finding a severity from that cell, and a report generator that parses the table gets a string that is not in `Critical | High | Medium | Low | Info`.

# Why

The lint had one severity check, "every Severity guidance row uses a contract severity", and it read only `section(md, "Severity guidance")`. The observation tables live under a different heading, so their last column was never inspected. The prose came straight from the research briefs: an agent asked to "propose a severity" for an observed row wrote a nuanced sentence, and the applier copied the sentence into the cell because the applier rule said to transcribe the brief's section 4 rows. Every test still passed, which is exactly the false-confidence case the guidance-table check had been written to prevent.

Three appliers, three sonnet task reviewers, and one re-review all missed it. It was caught only by the opus adversarial verifiers, who read every cell against the Evidence Contract by hand and returned eleven findings of this one kind.

# Fix

A second lint, "every observation-table severity cell is a single contract severity", reads `section(md, "What browser observation closes")`, skips the `Artefact` header and the `---` separator, and requires the last cell of every row to be exactly one token from `SEVERITIES`. It was seen failing first, on a deliberately broken cell in `api.md`, before the modules were declared clean, per [Guards must be seen failing](/constraints/guards-must-be-seen-failing.md). Any new table whose last column is meant to be a severity needs the same treatment; a table the lint does not read is a table the lint does not guard.

# How it was found

Not by the tests and not by the task-scoped reviews. Three opus verifiers were told to refute every added line against the Evidence Contract, one of the six defect kinds being "the severity is not exactly one token from the vocabulary". They found the cells because they read the column, not because anything flagged it. The fix wave normalised the cells and moved each nuance into the "Gap it closes" column; the final whole-branch review then swept every table in all 52 modules and found two more. The lint was added afterwards so the next campaign does not depend on a reviewer remembering to look.
