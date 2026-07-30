# Prompt/Spec Gap

What would a reasonable request for this work have failed to ask for? This is the meta module: it audits the *instructions*, not the code. It exists because the most expensive omissions are the ones nobody thought to specify.

Run it last. It needs the findings from the other modules as raw material.

## Reconstruct the implied ask

- [ ] For each significant subsystem, write the one-sentence request that would plausibly have produced it ("add project scoping to the structural tools").
- [ ] List what that sentence does **not** say but the implementation needed anyway: error handling, empty states, concurrency, cleanup, migration, observability, docs.
- [ ] Each gap that the code also missed is a finding. Each gap the code handled anyway is worth naming as a strength — it tells you where the team's instincts are good.

## Dimensions a prompt routinely omits

Walk this list against the subsystem under audit. These are the categories that almost never appear in a request and almost always matter:

- [ ] **Failure** — what happens when the dependency is down, the disk is full, the token expired mid-operation.
- [ ] **Empty and boundary** — zero items, one item, maximum items, first run, nothing configured.
- [ ] **Concurrency** — two of these at once, the same operation twice, a partial run resumed.
- [ ] **Cleanup** — what removes what this created. Most requests say "add", none say "and remove".
- [ ] **Idempotency** — running it twice.
- [ ] **Migration** — what happens to state written by the previous version.
- [ ] **Observability** — how anyone would know this broke in production.
- [ ] **Test isolation** — whether running the tests touches anything outside the temp directory.
- [ ] **Ownership** — whether this writes to a path someone else owns.
- [ ] **Docs** — whether the thing that ships is discoverable by the person who needs it.

## Spec vs. implementation drift

- [ ] Where written specs, plans, or ADRs exist, compare them to the code. Report both directions: spec'd and not built, built and not spec'd.
- [ ] Assertions in specs that no test enforces. A requirement with no test is a hope.
- [ ] Deviations that were the right call but never recorded. The code is correct and the document is now lying — that is a real finding, and the cheapest one to fix.

## Output

Report this module as two lists, not as severities:

1. **Gaps the implementation also missed** — these become findings in their proper module, cross-referenced here.
2. **Gaps the implementation covered anyway** — these are not defects. State them, because they tell the reader which dimensions this team does not need reminding about, and which they do.

Then name the single dimension most likely to be omitted from the *next* request on this codebase, with the evidence that led you there.
