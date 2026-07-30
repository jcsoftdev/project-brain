# Documentation

Can someone else use and change this? Documentation findings are verifiable: follow the instructions literally and report where they fail. **Do not assess whether docs "look thorough" — execute them.**

## Correctness

- [ ] Every documented command, path, flag, and signature exists. `search_code` each one. A documented flag the parser does not accept is `Medium`; readers trust docs over code.
- [ ] Follow the install and first-run instructions exactly as written, on a clean assumption. Report every missing prerequisite, wrong path, and undocumented step.
- [ ] Code examples match current signatures. Test one against the real symbol with `find_symbol`.
- [ ] No documentation of features that no longer exist. Cross-reference `Reachability` for the inverse.
- [ ] Claims about behaviour are true. This repo's own README claimed skills were "installed globally" when nothing installed them — a false claim is worse than a gap, because nobody investigates what they believe is handled.

## Coverage

- [ ] Purpose stated up front — what this is and who it is for. Cross-reference `goal.md`.
- [ ] Every public entry point documented: commands, endpoints, exported functions, config keys, environment variables.
- [ ] Every configuration option documented with its type, default, and effect.
- [ ] Prerequisites and supported platforms stated, and matching what the code requires.
- [ ] Failure modes documented: what common errors mean and what to do about them.
- [ ] A path from install to first useful result, in order.

## Structure

- [ ] A reader can find what they need without reading everything. Reference material separate from tutorials.
- [ ] Nothing important lives only in a comment, a commit message, or an issue.
- [ ] Docs live near what they describe, so a change is likely to update both.
- [ ] No duplicated documentation of the same thing in two places — they will diverge, and the reader cannot tell which is current.

## In-code documentation

- [ ] Non-obvious code explains **why**, not what. A comment restating the line is noise; a missing rationale on a surprising line is a real gap.
- [ ] Public APIs document their contract: what they accept, what they return, what they throw, what they mutate.
- [ ] Comments are current. A comment contradicting its code is `Medium` — cross-reference `consistency.md`.
- [ ] Workarounds record why they exist and what would let them be removed. An unexplained workaround is permanent by default.
- [ ] Deliberate deviations from an obvious approach say so, and say what was traded.

## Maintenance

- [ ] Something keeps docs honest — a test asserting required sections, a link check, or executable examples. Docs with no enforcement decay silently.
- [ ] Onboarding docs name an owner, or are recent enough to trust.
- [ ] Where specs, plans, or ADRs exist, they reflect what shipped. Cross-reference `prompt-spec-gap.md`; a plan describing a design the code abandoned actively misleads.

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
| Unexplained workaround | Low |
| Same thing documented in two places | Low |
| No enforcement keeping docs honest | Low |
