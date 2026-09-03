# Prompt/Spec Gap

What would a reasonable request for this work have failed to ask for? This is the meta module: it audits the *instructions*, not the code. It exists because the most expensive omissions are the ones nobody thought to specify.

Run it last. It needs the findings from the other modules as raw material. It is also the most opinion-prone module in this skill — the "implied ask" is a reconstruction, not a fact, so every gap below must resolve to a probe against real code, not a guess about what someone meant.

## Reconstruct the implied ask

- [ ] For each significant subsystem — pick them from `repo_map`'s top-ranked symbols or `get_architecture`'s module list, not intuition — write the one-sentence request that would plausibly have produced it, e.g. "add project scoping to the structural tools".
List what that sentence does **not** say but the implementation needed anyway: error handling, empty states, concurrency, cleanup, migration, observability, docs — the fixed dimension list below, walked against the sentence reconstructed above; do not improvise new dimensions per subsystem, or the coverage becomes unrepeatable across audits.

- [ ] For each dimension, `find_symbol` the subsystem's entry point and read its handling directly — do not infer from the interface alone. A gap the code also missed is a finding in its proper module, cross-referenced here. A gap the code handled anyway is worth naming as a strength — it tells you where the team's instincts are good.

## Dimensions a prompt routinely omits

Walk this list against the subsystem under audit. Each dimension names its probe; a dimension with no probe run against it produces no finding, not an `inferred` one.

- [ ] **Failure** — what happens when the dependency is down, the disk is full, the token expired mid-operation. `search_code` the dependency's call site for a surrounding try/catch or error branch. Rule out a global error-handler/middleware catching it upstream before calling the local absence a gap. Cross-reference `failure.md`'s swallowed-error and wrapped-call checks; reuse its finding rather than re-deriving it here.
- [ ] **Empty and boundary** — zero items, one item, maximum items, first run, nothing configured. `find_symbol` the subsystem's entry point and read for a guard on empty/undefined input before the main logic runs. Rule out schema-level validation upstream of the entry point already rejecting the boundary case before it gets here.
- [ ] Where a call site requests structured/constrained output from an LLM (`search_code` for a `schema`/`output_format`/`strict` argument name near the call, then `Read`/`expand_context` the call site to confirm one is actually passed), confirm the implied ask ("return JSON matching this schema") was not silently read as "return correct values matching this schema." `find_callees` on the consumer of the structured response for a plausibility or reality check on a field the schema marks required (reuse `ai.md`'s "hallucination-sensitive outputs... verified against reality" finding, do not re-derive) before that field drives a write, a user-facing claim, or a downstream decision. Rule out a low-stakes display-only field with no downstream write, decision, or claim of fact (e.g. a suggested chat title) — schema validity is sufficient when nothing consumes the value as ground truth. (Anthropic, "Structured outputs," official documentation — https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [ ] **Empty and boundary, adversarial instance** — where an AI/LLM call site's prompt is built in part from externally-sourced content (a fetched URL, an uploaded file, a tool/function result, a retrieval result — `find_callees` on the prompt-construction function for the origin of each concatenated input), and `ai.md`'s own delimiter check already found the input properly delimited from instructions, still `search_code` the test directory for a fixture where that external content itself contains an instruction-shaped string, asserting the model did not comply with it. A structurally-sound delimiter with no test proving it holds under a hostile input is an unverified assumption standing in for a spec, not a spec. Rule out externally-sourced content that is never used to authorize an action, only displayed or summarized back to the same user who supplied it, with no privileged operation reading the model's output (`find_callers` on the response-handling function to check) — that narrows the blast radius enough to drop this to Medium rather than High. (OWASP GenAI Security Project, "LLM01:2025 Prompt Injection" — https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [ ] **Concurrency** — two of these at once, the same operation twice, a partial run resumed. `search_code` for a lock, mutex, transaction wrapper, or advisory-lock pattern around the operation. Rule out a single-writer guarantee provided by the runtime itself (a single-threaded worker, a queue with concurrency 1) before flagging its absence. Cross-reference `concurrency.md`'s module-level mutable-state checks; reuse its finding rather than re-deriving it here.
- [ ] **Cleanup** — what removes what this created. `search_code` the resource name alongside a `delete`/`remove`/`teardown` verb. Rule out a TTL/auto-expiry mechanism that makes explicit deletion unnecessary. Most requests say "add", none say "and remove" — an unmatched create with neither is the gap.
- [ ] **Idempotency** — running it twice. Cross-reference `functional.md`'s State and idempotency section (`find_symbol` the operation and read for an upsert/check-before-write/idempotency key); reuse its finding rather than re-deriving it here.
- [ ] **Migration** — what happens to state written by the previous version. `search_code` a migrations directory or a version-check branch reading old-shape data; its absence next to a changed persisted shape is the gap.
- [ ] **Observability** — how anyone would know this broke in production. `search_code` a logger/metrics/tracing call inside the subsystem's error branch; a silent catch block is the gap. Rule out a global error-handler/middleware logging it upstream before calling the local absence a gap.
- [ ] **Test isolation** — whether running the tests touches anything outside the temp directory. `search_code` the test file for a hardcoded path, a shared fixture directory, or missing setup/teardown around external state. Cross-reference `testing.md`'s isolation checks; reuse its finding rather than re-deriving it here.
- [ ] **Observability and Test isolation, instantiated for an AI call site** — when the entry point identified is an AI/LLM call (`ai.md`'s gate fired) and the implied ask's spec lives in a prompt template rather than typed code, treat "no version marker + no regression test" as its own severity band, not the generic "any other dimension" row: `search_code` the prompt constant/file for a version or date marker (reuse `ai.md`'s own "prompts are versioned" finding rather than re-deriving it) AND `search_code` the test directory for a golden-output or regression fixture referencing that prompt (reuse `ai.md`'s Evaluation finding). Both absent on a prompt whose output is acted on downstream without human review is the finding. Rule out a human reviewing every output of this prompt before it is acted on (cross-reference `ai.md`'s Output-handling checks for that review gate) — an unversioned, untested prompt whose every output is human-checked is a process risk, not a silent-drift risk, and drops to the "any other dimension" Medium row. (Anthropic, "Prompt engineering overview," official documentation — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview; Sclar, Choi, Tsvetkov & Suhr, "Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design," arXiv, 2023 — https://arxiv.org/abs/2310.11324)
- [ ] **Ownership** — whether this writes to a path someone else owns. `search_code` the write target's path construction. Rule out a path shared by documented convention or contract before calling it a boundary violation.
- [ ] **Docs** — whether the thing that ships is discoverable by the person who needs it. Cross-reference `documentation.md`'s coverage checks (`get_architecture`/`repo_map` the entry-point list, then `search_code` each name against the docs); reuse its finding rather than re-deriving it here.

## Spec vs. implementation drift

- [ ] Where written specs, plans, or ADRs exist, compare them to the code. `search_code` the specced behaviour's keyword in the implementation to confirm it exists. Report both directions: spec'd and not built, built and not spec'd.
- [ ] Assertions in specs that no test enforces. `search_code` the spec's stated requirement's keyword inside the test directory — zero hits means a requirement with no test, which is a hope, not a guarantee.
- [ ] Deviations that were the right call but never recorded. Diff the spec's described approach against what `find_symbol` shows was actually built; a difference with no comment or ADR explaining it means the code is correct and the document is now actively lying.

## Out of static reach

- Whether an omitted dimension was actually acceptable to skip for this subsystem's risk profile — that is a judgement call, not a probe result.
- Whether a gap the code "handled anyway" was deliberate foresight or an accidental side effect of a stricter library default.
- Whether the reconstructed one-sentence ask matches the real request, when no ticket, issue, or commit message records it.
- Dimensions genuinely outside this fixed list — one this list itself omits stays invisible to the audit.
- Whether this prompt's behavior is sensitive to its own formatting — this module can find that no regression test exists to catch it, not whether a specific edit would in fact change the output.
- Whether the LLM-as-judge grader this codebase uses is actually reliable for its task — this module can confirm a grader exists and is a different model than the one graded, not that its judgments are correct.
- Whether a tested injection guard actually holds against real attacks — this module confirms a test exists and asserts the expected behavior, not that the assertion would survive an attacker who iterates against it.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` cross-referenced with `steps.md` (the promise's copy text, captured verbatim near the step) and `final-state.md`/`screenshots/` | UI-promised AI behavior (e.g. "cites sources," "your data stays private," "instant answers") vs. the actual prompt/response payload observed for the same interaction — refuted if the app's frontend calls its own backend rather than the model provider directly, so `network.jsonl` shows the app's API response, not the literal prompt sent to the LLM; check `final-state.md`/screenshots for the rendered claim before concluding the promise was broken | High |

## Severity guidance

| Situation | Severity |
|---|---|
| Gap the implementation also missed, in a security-, money-, or data-loss-bearing dimension | High |
| AI-call prompt spec with no version marker and no regression test, output consumed downstream without human review | High |
| Gap the implementation also missed, any other dimension | Medium |
| Gap the implementation covered anyway | Info |

## Output

Report this module as two lists:

1. **Gaps the implementation also missed** — a gap with a named owning module (`failure.md`, `concurrency.md`, `functional.md`, `testing.md`, `documentation.md` above) is re-filed there and takes that module's severity, not the table below; that module ran, or didn't, independently of this one. The table above applies only to a gap whose owning module did not run this audit, or that no other module owns.
2. **Gaps the implementation covered anyway** — these are not defects. State them, because they tell the reader which dimensions this team does not need reminding about, and which they do.

Then name the single dimension most likely to be omitted from the *next* request on this codebase, with the evidence that led you there.
