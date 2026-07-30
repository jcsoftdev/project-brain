# Product

Who is this for, and does the shape of the code agree? This module audits the product surface, not the implementation — a codebase can be technically excellent and still ship the wrong thing.

Start with `get_architecture` and `repo_map`. The highest-PageRank symbols are the product's real center of gravity; if they do not match what the README says the product is about, that gap is the finding.

## Users and jobs

- [ ] The repo states who the user is. If no doc says it, infer it from the entry points and say you inferred it — that ambiguity is itself worth reporting.
- [ ] Each primary user job maps to a real, reachable code path. Trace one with `trace_path` from entry point to effect.
- [ ] Nothing in the codebase serves a user the docs never mention. Unexplained surface is either an undocumented feature or abandoned work.

## Surface coherence

- [ ] One way to do each thing, or a stated reason for more than one. Three overlapping commands that half-solve the same job is a product defect before it is a code defect.
- [ ] Naming is consistent with the user's vocabulary, not the implementation's. A CLI flag named after an internal class leaks the model.
- [ ] Defaults serve the common case. Count how many flags a user must pass to do the most obvious thing — if it is more than zero, ask why.
- [ ] Error messages tell the user what to do next, not what went wrong internally.

## Onboarding path

- [ ] There is a shortest path from install to first value, and it is documented. Follow it literally against the repo and note every step that is missing, wrong, or assumed.
- [ ] Prerequisites are stated before they are needed, not discovered by failure.
- [ ] The first-run experience handles the empty state — no data, no config, no index.

## Feature economics

- [ ] For each feature, is there evidence anyone uses it? Cross-check with the `Reachability` module: a feature with no in-repo caller and no doc is a maintenance cost with no return.
- [ ] Features that exist only for one caller — worth reporting as candidates for inlining or removal.
- [ ] Configuration options that no code branches on. Same category.

## Reporting

Product findings are the easiest to state as opinion and the hardest to defend. Anchor each one: a `file:line`, a missing doc section, or a traced path that dead-ends. If the only evidence is your judgement, mark the confidence low and say what would settle it.
