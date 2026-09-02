# Product

Who is this for, and does the shape of the code agree? This module audits the product surface, not the implementation — a codebase can be technically excellent and still ship the wrong thing.

Start with `get_architecture` and `repo_map`. The highest-PageRank symbols are the product's real center of gravity; if they do not match what the README says the product is about, that gap is the finding.

## Users and jobs

- [ ] The repo states who the user is. `search_code`/`search_context` the README opening and package description for an audience statement. If no doc says it, infer it from `repo_map`'s top entry points and say you inferred it — that ambiguity is itself worth reporting.
- [ ] Each primary user job maps to a real, reachable code path. Trace one with `trace_path` from entry point to effect.
- [ ] Nothing in the codebase serves a user the docs never mention. Cross-check `repo_map`'s highest-PageRank symbols against the stated audience, then `find_callers` on any that don't match. Rule out an internal/admin/ops surface never meant for the documented user before calling it unexplained. Unexplained surface is either an undocumented feature or abandoned work.

## Surface coherence

- [ ] One way to do each thing, or a stated reason for more than one. `search_code` for near-duplicate command/route names sharing a verb or noun — three overlapping commands that half-solve the same job is a product defect before it is a code defect. Before flagging, check docs/comments for a stated reason (a deliberate alias, an in-progress `v1`/`v2` migration) — the finding is duplication with no stated reason, not duplication alone.
- [ ] Naming is consistent with the user's vocabulary, not the implementation's. `find_symbol` the CLI flag or API field; a name matching an internal class or table rather than a user concept leaks the model.
- [ ] Defaults serve the common case. `find_symbol` the entry point's signature and count required parameters with no default for the single most common invocation — more than zero is the finding. Rule out parameters that are inherently required by the operation's own semantics, with no legitimate default value — the finding is a missing default where one plausibly exists.
- [ ] Error messages tell the user what to do next, not what went wrong internally. `search_code` the error-message strings raised at trust boundaries; a message that names an internal type, class, or file path is the finding.

## Onboarding path

- [ ] There is a shortest path from install to first value, and it is documented. Follow it literally against the repo — `find_symbol` each command it names — and note every step that is missing, wrong, or assumed. Cross-reference `documentation.md`'s onboarding-path check — run once, report the product-fit angle here and the doc-accuracy angle there.
- [ ] Prerequisites are stated before they are needed, not discovered by failure. Read the doc's install section top to bottom; a prerequisite mentioned only in a later troubleshooting section is the finding.
- [ ] The first-run experience handles the empty state — no data, no config, no index. `find_symbol` the entry point invoked on a fresh checkout and read its behaviour when the expected file/config is absent.

## Feature economics

- [ ] For each feature, is there evidence anyone uses it? `find_callers` the feature's entry point — zero in-repo callers plus no doc mention is a maintenance cost with no return. Cross-check with `Reachability`.
- [ ] Features that exist only for one caller. `find_callers` each exported feature entry point; exactly one caller is a candidate for inlining. Rule out a deliberately public API awaiting external consumers — check the manifest for a declared `exports`/public-package marker before reporting it as unused.
- [ ] Configuration options that no code branches on. `search_code` the option name in the parser, then `find_callers` on the parsed value. Rule out a string-keyed/reflective read (see `reachability.md`'s exclusion list) before calling it decorative. This is `reachability.md`'s dead-config-option check, filtered to product-facing options — reuse its result rather than re-running the search.

## Reporting

Product findings are the easiest to state as opinion and the hardest to defend. Anchor each one: a `file:line`, a missing doc section, or a traced path that dead-ends. If the only evidence is your judgement, mark the confidence low and say what would settle it.

## Out of static reach

- Whether the stated user actually matches who uses the product in practice — usage data is not in source.
- Whether the onboarding path *feels* short to a newcomer, versus its literal step count — the subjective "feels short" judgement stays out of reach regardless.
- Whether an error message is genuinely clear to the user it addresses, beyond "does it name an internal detail".
- Product-market judgements — whether the job being served is worth serving at all.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether the documented onboarding path actually completes end-to-end, and its real step count | High |

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
