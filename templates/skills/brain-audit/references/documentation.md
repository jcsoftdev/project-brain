# Documentation

Can someone else use and change this? Documentation findings are verifiable: follow the instructions literally and report where they fail. **Do not assess whether docs "look thorough" — execute them.**

## Correctness

- [ ] Every documented command, path, flag, and signature exists. `search_code` each one against the parser/dispatcher. A documented flag the parser does not accept is `Medium`; readers trust docs over code.
- [ ] Follow the install and first-run instructions exactly as written, on a clean-checkout assumption. `find_symbol` each command or script the doc names, in the order the doc gives them, and confirm each exists and accepts the arguments shown. Report every missing prerequisite, wrong path, and undocumented step.
- [ ] Code examples match current signatures. `find_symbol` the real signature and diff it literally against the example — parameter names, order, and return shape.
- [ ] No documentation of features that no longer exist. `search_code` the documented feature's name/symbol in the source; zero hits confirms removal. Rule out a rename before calling it stale — search under a plausible new name too. Cross-reference `Reachability` for the inverse.
- [ ] Claims about behaviour are true. `find_symbol` the function the claim describes and read it directly — do not accept the doc's wording as evidence of its own accuracy. This repo's own README once claimed skills were "installed globally" when nothing installed them; a false claim is worse than a gap, because nobody investigates what they believe is handled.

## Coverage

- [ ] Purpose stated up front — what this is and who it is for. `search_code`/`search_context` the README's opening section for an audience/purpose statement. Cross-reference `goal.md`.
- [ ] Every public entry point documented: commands, endpoints, exported functions, config keys, environment variables. `get_architecture`/`repo_map` for the full entry-point list, then `search_code` each name against the docs — an entry point with zero doc hits is the gap.
- [ ] Every configuration option documented with its type, default, and effect. `search_code` the config schema/parser for every key, then check each appears in docs with all three of type, default, and effect — name-only documentation is still a gap.
- [ ] Prerequisites and supported platforms stated, and matching what the code requires. `search_code` the manifest's engine/platform constraints (`engines`, `python_requires`, a Dockerfile base image) and diff against what the docs claim.
- [ ] Failure modes documented: what common errors mean and what to do about them. `search_code` the entry point's thrown/returned error messages and check each has a corresponding doc entry — an error string with no doc mention is the gap.
- [ ] A path from install to first useful result, in order. Read the doc top to bottom and confirm no step depends on a later one. Cross-reference `product.md`'s onboarding path check; reuse its finding rather than re-deriving it here.

## Structure

- [ ] A reader can find what they need without reading everything. Documentation is organised by the reader's intent, not merely by feature area — the Diátaxis framework's four modes (tutorial: a hands-on lesson; how-to: steps toward one task; reference: facts, consulted rather than read; explanation: the background and the why) are the vocabulary practitioners actually use to name this split. `list_modules`, or read the docs directory tree directly — a single flat file mixing tutorial prose, task steps, and reference tables is the finding; note which of the four modes exist at all for this project and which are entirely absent, since a project with no explanation/why documentation has a different gap than one with no reference.
- [ ] Reference material reads cleanly as an isolated fragment. Read one reference page or section with no surrounding tutorial context and confirm it still makes sense on its own — a reference entry that depends on narrative set up earlier in a different document fails a reader who jumped straight to it mid-task, and fails identically for any retrieval-based system (a search index, or this skill's own project-brain) that surfaces the section as a standalone chunk.
- [ ] No step assumes knowledge the doc never states. Read each instruction in the install/first-run path and confirm every input it requires — an account, a config value, a secret, a prior step performed elsewhere — is documented as a prerequisite before it is used, not assumed already known to the reader.
- [ ] Nothing important lives only in a comment, a commit message, or an issue. `search_code` for a comment stating a constraint or contract with no counterpart in any doc file — that constraint is invisible to anyone who doesn't read that exact line.
- [ ] Docs live near what they describe, so a change is likely to update both. Compare the doc file's path to the code path it documents — a doc for `src/auth/` living only in a top-level `/docs` with no cross-link is more likely to rot.
- [ ] No duplicated documentation of the same thing in two places. `search_code` a distinctive phrase or heading from one doc file against the rest of the docs tree — a hit in a second file is the duplicate; they will diverge, and the reader cannot tell which is current. This is the single most commonly reported documentation defect in practice, ahead of any individual accuracy gap.

## In-code documentation

- [ ] Non-obvious code explains **why**, not what. Read a sample of comments near `repo_map`'s highest-PageRank symbols — a comment restating the line (`// increment i` above `i++`) is noise; a missing rationale on a surprising line (a magic number, an early return, a suppressed lint) is a real gap.
- [ ] Public APIs document their contract: what they accept, what they return, what they throw, what they mutate. `find_symbol` each exported function and check its docstring/JSDoc covers all four; a signature with none is the gap.
- [ ] Comments are current. `find_symbol` the commented code and read both together — a comment contradicting its code is `Medium`; cross-reference `consistency.md`.
- [ ] Workarounds record why they exist and what would let them be removed. `search_code` for `workaround`/`hack`/`XXX` and check each has an adjacent explanation — an unexplained workaround is permanent by default.
- [ ] Deliberate deviations from an obvious approach say so, and say what was traded. `search_code` a non-obvious implementation choice (a manual loop where a library call would be idiomatic) and check for a comment explaining the tradeoff.

## Maintenance

- [ ] Something keeps docs honest — a test asserting required sections, a link check, or executable examples. `search_code` the CI config and test directory for a docs-lint, link-check, or doctest step; its absence means docs decay silently.
- [ ] Onboarding docs name an owner, or are recent enough to trust. Read the doc's header/footer for an owner or last-updated marker; if absent and `Repo History` is in the confirmed module set, use the file's last-commit date as a proxy for trust.
- [ ] Where specs, plans, or ADRs exist, they reflect what shipped. `find_symbol` the component the spec describes and diff its real shape against the spec's. Cross-reference `prompt-spec-gap.md`; a plan describing a design the code abandoned actively misleads.

## Out of static reach

- Whether a reader actually succeeds following the docs, versus the steps being present and in the right order.
- Whether an in-code comment's rationale is still true today, when nothing pins it to the constraint it described.
- Perceived clarity of an error message or doc passage to someone unfamiliar with the codebase.
- Whether the docs owner named in a header is still the right person to ask.

## Severity guidance

| Situation | Severity |
|---|---|
| Documented behaviour that is false | High |
| Install or first-run instructions that do not work | High |
| Undocumented required configuration | High |
| Documented flag, path, or command that does not exist | Medium |
| Comment that contradicts its code | Medium |
| Public entry point with no documentation | Medium |
| Spec or plan describing an abandoned design | Medium |
| Instruction step assumes an undocumented prerequisite | Medium |
| One of the four Diátaxis modes entirely absent where the project needs it | Low |
| Reference material that only makes sense with tutorial context read first | Low |
| Unexplained workaround | Low |
| Same thing documented in two places | Low |
| No enforcement keeping docs honest | Low |
