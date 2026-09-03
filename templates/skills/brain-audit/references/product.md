# Product

Who is this for, and does the shape of the code agree? This module audits the product surface, not the implementation — a codebase can be technically excellent and still ship the wrong thing.

Start with `get_architecture` and `repo_map`. The highest-PageRank symbols are the product's real center of gravity; if they do not match what the README says the product is about, that gap is the finding.

## Users and jobs

- [ ] The repo states who the user is. `search_code`/`search_context` the README opening and package description for an audience statement. If no doc says it, infer it from `repo_map`'s top entry points and say you inferred it — that ambiguity is itself worth reporting. (Cagan, "Product Discovery," Silicon Valley Product Group — https://www.svpg.com/product-discovery/)
- [ ] Each primary user job maps to a real, reachable code path. Trace one with `trace_path` from entry point to effect. (Nielsen Norman Group, "Task Analysis" — https://www.nngroup.com/articles/task-analysis/)
- [ ] Nothing in the codebase serves a user the docs never mention. Cross-check `repo_map`'s highest-PageRank symbols against the stated audience, then `find_callers` on any that don't match. Rule out an internal/admin/ops surface never meant for the documented user before calling it unexplained. Unexplained surface is either an undocumented feature or abandoned work.
- [ ] Compare the job the README/marketing copy states (the words used to describe *why* someone would use this) against what `get_architecture`'s and `repo_map`'s highest-PageRank symbols actually optimize for. A stated job in social/emotional terms ("collaborate effortlessly") backed by a code center of gravity that is entirely about one narrow mechanical operation is a mismatch worth naming — this runs the comparison in the opposite direction from the "nothing in the codebase serves an undocumented user" check above. Rule out the stated job legitimately spanning functional, social, and emotional dimensions with the code's center of gravity as the functional core enabling the rest — name which dimension the code serves before calling it a mismatch. (Christensen Institute, "Jobs to Be Done" — https://www.christenseninstitute.org/theory/jobs-to-be-done/; Cagan, "Product vs. Project Teams," Silicon Valley Product Group — https://www.svpg.com/product-vs-project-teams/)

## Surface coherence

- [ ] One way to do each thing, or a stated reason for more than one. `search_code` for near-duplicate command/route names sharing a verb or noun — three overlapping commands that half-solve the same job is a product defect before it is a code defect. Before flagging, check docs/comments for a stated reason (a deliberate alias, an in-progress `v1`/`v2` migration) — the finding is duplication with no stated reason, not duplication alone. Where two or more such commands share no stated reason, run `find_callees` on each for a one-hop comparison of their immediate downstream calls, then `trace_path` (or `impact`) between the two entry points to prove whether they actually reach the same mutating/read effect through different call paths — `find_callees` alone only enumerates each command's direct calls, it cannot prove a transitive shared reach. If `trace_path`/`impact` confirms the shared effect, report it as `traced`, not `inferred`, and name the shared effect; if they diverge in effect (one mutates, one is read-only), they are not half-solving the same job — do not report as duplication. (Nielsen, "10 Usability Heuristics for User Interface Design," Nielsen Norman Group — https://www.nngroup.com/articles/ten-usability-heuristics/; Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 15, 2020 — https://abseil.io/resources/swe-book/html/ch15.html)
- [ ] Naming is consistent with the user's vocabulary, not the implementation's. `find_symbol` the CLI flag or API field; a name matching an internal class or table rather than a user concept leaks the model. (Nielsen, "10 Usability Heuristics for User Interface Design," Nielsen Norman Group — https://www.nngroup.com/articles/ten-usability-heuristics/)
- [ ] Defaults serve the common case. `find_symbol` the entry point's signature and count required parameters with no default for the single most common invocation — more than zero is the finding. Rule out parameters that are inherently required by the operation's own semantics, with no legitimate default value — the finding is a missing default where one plausibly exists.
- [ ] If the primary user job is one a user plausibly repeats (not a one-shot setup step), check whether the entry point offers any faster path for repeat use — a batch mode, a non-interactive flag, a saved-config shortcut. `find_symbol` the entry point's signature and `search_code` for batch/script/non-interactive/`--yes`-style flag names; their absence on a repeatable job is the finding. Rule out a job that is inherently single-shot (e.g., a one-time install step) where repetition is not a realistic usage pattern — confirm the job is one a user plausibly repeats before flagging. (Nielsen, "10 Usability Heuristics for User Interface Design" — Heuristic #7, Flexibility and efficiency of use, Nielsen Norman Group — https://www.nngroup.com/articles/ten-usability-heuristics/)
- [ ] Error messages tell the user what to do next, not what went wrong internally. `search_code` the error-message strings raised at trust boundaries; a message that names an internal type, class, or file path as the primary text is the finding — the same detail surfaced in a secondary/collapsed technical-details region is not. Where such a message is found, `Read` the surrounding handler for whether it discards or preserves the user's already-entered input on failure — discarding non-trivial input (a multi-field form, a multi-step wizard) forces a full retype and is a distinct finding from a jargon-leaking message; rule out a single trivial field (e.g., a one-word CLI flag) where retyping costs nothing. (Nielsen Norman Group, "Error Message Guidelines" — https://www.nngroup.com/articles/error-message-guidelines/)

## Onboarding path

- [ ] There is a shortest path from install to first value, and it is documented. Follow it literally against the repo — `find_symbol` each command it names — and note every step that is missing, wrong, or assumed. Cross-reference `documentation.md`'s onboarding-path check — run once, report the product-fit angle here and the doc-accuracy angle there. (Nielsen Norman Group, "Onboarding Tutorials: Definition and Best Practices" — https://www.nngroup.com/articles/onboarding-tutorials/)
- [ ] Prerequisites are stated before they are needed, not discovered by failure. Read the doc's install section top to bottom; a prerequisite mentioned only in a later troubleshooting section is the finding.
- [ ] The first-run experience handles the empty state — no data, no config, no index. `find_symbol` the entry point invoked on a fresh checkout and read its behaviour when the expected file/config is absent.
- [ ] `trace_path` from the documented install entry point to the first invocation of the user's stated primary job. Any intermediate mandatory step (`find_symbol` a "setup"/"wizard"/"init" routine on that path) that the user cannot skip, and that does not itself supply a credential or config with no sane default, is a push-onboarding obstacle between install and first value — distinct from the "shortest path is undocumented" check above, which is about documentation, not a structurally forced detour. Cross-reference the "Defaults serve the common case" check before flagging; a step that is the only way to supply a required credential/config with no legitimate default is not an obstacle. (Nielsen Norman Group, "Onboarding Tutorials: Definition and Best Practices" — https://www.nngroup.com/articles/onboarding-tutorials/)

## Feature economics

- [ ] For each feature, is there evidence anyone uses it? `find_callers` the feature's entry point — zero in-repo callers plus no doc mention is a maintenance cost with no return. Cross-check with `Reachability`. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 15, 2020 — https://abseil.io/resources/swe-book/html/ch15.html)
- [ ] Features that exist only for one caller. `find_callers` each exported feature entry point; exactly one caller is a candidate for inlining. Rule out a deliberately public API awaiting external consumers — check the manifest for a declared `exports`/public-package marker before reporting it as unused.
- [ ] Configuration options that no code branches on. `search_code` the option name in the parser, then `find_callers` on the parsed value. Rule out a string-keyed/reflective read (see `reachability.md`'s exclusion list) before calling it decorative. This is `reachability.md`'s dead-config-option check, filtered to product-facing options — reuse its result rather than re-running the search.

## Reporting

Product findings are the easiest to state as opinion and the hardest to defend. Anchor each one: a `file:line`, a missing doc section, or a traced path that dead-ends. If the only evidence is your judgement, mark the confidence low and say what would settle it.

## Out of static reach

- Whether the stated user actually matches who uses the product in practice — usage data is not in source.
- Whether the onboarding path *feels* short to a newcomer, versus its literal step count — the subjective "feels short" judgement stays out of reach regardless.
- Whether an error message is genuinely clear to the user it addresses, beyond "does it name an internal detail".
- Product-market judgements — whether the job being served is worth serving at all.
- Whether the job this product actually gets hired for matches the job the code optimizes for — that requires user interviews this audit cannot conduct.
- A commitment made outside this repository (a support contract, an external changelog entry) that this audit cannot see from source.
- Whether a forced detour before first value is a UX defect or a legal/compliance requirement — the structural probe cannot tell the two apart.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether the documented onboarding path actually completes end-to-end, and its real step count | High |
| `steps.md` / `console.jsonl` | Error message shown on a deliberate invalid submission does not leak internal detail | Low |
| `routes.md` | Route reachable in the browser walk but never named in `repo_map`'s traced entry points, or vice versa — rule out a redirect-only alias or a legacy path kept for compatibility with a stated reason | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Undocumented subsystem serving no stated user, exclusions ruled out | Medium |
| Onboarding step missing, wrong, or order-dependent and undocumented | Medium |
| Naming that leaks the implementation into the user-facing surface | Medium |
| More than one command/route half-solving the same job, no stated reason | Medium |
| Error message exposing internal detail instead of next action | Low |
| Config option no code branches on, exclusions ruled out | Low |
| Feature with exactly one in-repo caller and no public-API marker | Low |
| Mandatory step forces a detour to the user's primary job with no credential/config justification | Medium |
| Stated job's social/emotional framing has no functional code behind it, dimension named | Medium |
| Primary job is repeatable but offers no faster path for repeat use | Low |
