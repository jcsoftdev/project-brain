# Documentation

Can someone else use and change this? Documentation findings are verifiable: follow the instructions literally and report where they fail. **Do not assess whether docs "look thorough" — execute them.**

## Correctness

- [ ] Every documented command, path, flag, and signature exists. `search_code` each one against the parser/dispatcher. A documented flag the parser does not accept is `Medium`; readers trust docs over code.
- [ ] Follow the install and first-run instructions exactly as written, on a clean-checkout assumption. `find_symbol` each command or script the doc names, in the order the doc gives them, and confirm each exists and accepts the arguments shown. Report every missing prerequisite, wrong path, and undocumented step. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] Code examples match current signatures. `find_symbol` the real signature and diff it literally against the example — parameter names, order, and return shape.
- [ ] No documentation of features that no longer exist. `search_code` the documented feature's name/symbol in the source; zero hits confirms removal. Rule out a rename before calling it stale — search under a plausible new name too. Cross-reference `Reachability` for the inverse.
- [ ] Claims about behaviour are true. `find_symbol` the function the claim describes and read it directly — do not accept the doc's wording as evidence of its own accuracy. This repo's own README once claimed skills were "installed globally" when nothing installed them; a false claim is worse than a gap, because nobody investigates what they believe is handled. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)

## Coverage

- [ ] Purpose stated up front — what this is and who it is for. `search_code`/`search_context` the README's opening section for an audience/purpose statement. Cross-reference `goal.md`. Where the README exists, its opening should state all five of GitHub's named elements: what the project does, why it's useful, how to get started, where to get help, and who maintains it — `search_code`/`Read` the README's first section against this five-part list; missing any one is the gap, unless it is genuinely not applicable (e.g., a solo hobby project with no "where to get help" channel) — name which is inapplicable and why, rather than treating its absence as a gap. (GitHub, Inc., "About READMEs" — https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [ ] Every public entry point documented: commands, endpoints, exported functions, config keys, environment variables. `get_architecture`/`repo_map` for the full entry-point list, then `search_code` each name against the docs — an entry point with zero doc hits is the gap. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] Every configuration option documented with its type, default, and effect. `search_code` the config schema/parser for every key, then check each appears in docs with all three of type, default, and effect — name-only documentation is still a gap.
- [ ] Prerequisites and supported platforms stated, and matching what the code requires. `search_code` the manifest's engine/platform constraints (`engines`, `python_requires`, a Dockerfile base image) and diff against what the docs claim. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] Failure modes documented: what common errors mean and what to do about them. `search_code` the entry point's thrown/returned error messages and check each has a corresponding doc entry — an error string with no doc mention is the gap.
- [ ] A path from install to first useful result, in order. Read the doc top to bottom and confirm no step depends on a later one. Cross-reference `product.md`'s onboarding path check; reuse its finding rather than re-deriving it here. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] A CHANGELOG (or release notes) exists, and each entry states what changed, when, and under which category (Added/Changed/Deprecated/Removed/Fixed/Security), newest first. `search_code` for CHANGELOG.md/HISTORY.md; if found, `Read` it and confirm entries are dated and grouped by type rather than a raw commit-log dump. Rule out a project with no tagged, externally-consumed releases (an internal service redeployed continuously, no version field in the manifest) — confirm via the manifest's version field before flagging, and report this Out of static reach instead. (Lacan et al., "Keep a Changelog" v1.1.0 — https://keepachangelog.com/en/1.1.0/)
- [ ] A security policy (SECURITY.md, in the repo root, `.github/`, or `docs/`) states supported versions and how to report a vulnerability. `search_code` for SECURITY.md in the three recognized locations; a project accepting external contributions or exposing a network entry point with none is the gap. Rule out a private project with no path for an external party to discover or report a vulnerability through this channel — confirm via a checkable signal that the project is not externally facing (no LICENSE file, no CONTRIBUTING file, no public issue-template directory under `.github/ISSUE_TEMPLATE/`) before flagging; a manifest's `private` field does not establish this, since it is routinely set on public repositories to block registry publication and says nothing about visibility. (GitHub, Inc., "Adding a security policy to your repository" — https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository)
- [ ] A CONTRIBUTING file exists in one of GitHub's three recognized locations (`.github/`, root, `docs/`, in that priority order) and its described process (branch naming, required checks, review) matches the actual CI config. `search_code` for CONTRIBUTING.md in these locations; when found, diff its stated steps against `.github/workflows/` or equivalent CI configuration. Rule out a single-maintainer project with no open external-contribution path — confirm no contribution-adjacent language exists in the README either before flagging as a gap rather than a deliberate choice. (GitHub, Inc., "Setting guidelines for repository contributors" — https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)

## Structure

- [ ] A reader can find what they need without reading everything. Documentation is organised by the reader's intent, not merely by feature area — the Diátaxis framework's four modes (tutorial: a hands-on lesson; how-to: steps toward one task; reference: facts, consulted rather than read; explanation: the background and the why) are the vocabulary practitioners actually use to name this split. `list_modules`, or read the docs directory tree directly — a single flat file mixing tutorial prose, task steps, and reference tables is the finding; note which of the four modes exist at all for this project and which are entirely absent, since a project with no explanation/why documentation has a different gap than one with no reference.
- [ ] Reference material reads cleanly as an isolated fragment. Read one reference page or section with no surrounding tutorial context and confirm it still makes sense on its own — a reference entry that depends on narrative set up earlier in a different document fails a reader who jumped straight to it mid-task, and fails identically for any retrieval-based system (a search index, or this skill's own project-brain) that surfaces the section as a standalone chunk. (Diátaxis maintainers, "Reference," official framework site — https://diataxis.fr/reference/)
- [ ] No step assumes knowledge the doc never states. Read each instruction in the install/first-run path and confirm every input it requires — an account, a config value, a secret, a prior step performed elsewhere — is documented as a prerequisite before it is used, not assumed already known to the reader. (Google Developers, "Technical Writing One" — https://developers.google.com/tech-writing/one)
- [ ] Nothing important lives only in a comment, a commit message, or an issue. `search_code` for a comment stating a constraint or contract with no counterpart in any doc file — that constraint is invisible to anyone who doesn't read that exact line.
- [ ] Docs live near what they describe, so a change is likely to update both. `Read` the doc file's path against the code path it documents — a doc for `src/auth/` living only in a top-level `/docs` with no cross-link is more likely to rot.
- [ ] No duplicated documentation of the same thing in two places. `search_code` a distinctive phrase or heading from one doc file against the rest of the docs tree — a hit in a second file is the duplicate; they will diverge, and the reader cannot tell which is current. Rule out a short warning or prerequisite kept verbatim on purpose across two entry points for reader safety (the same security caveat in both a quickstart and a security doc) — the finding is near-duplicate *prose* likely to diverge, not an intentionally mirrored short notice. This is the single most commonly reported documentation defect in practice, ahead of any individual accuracy gap.

## In-code documentation

- [ ] Non-obvious code explains **why**, not what. Read a sample of comments near `repo_map`'s highest-PageRank symbols — a comment restating the line (`// increment i` above `i++`) is noise; a missing rationale on a surprising line (a magic number, an early return, a suppressed lint) is a real gap. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] Public APIs document their contract: what they accept, what they return, what they throw, what they mutate. `find_symbol` each exported function and check its docstring/JSDoc covers all four; a signature with none is the gap.
- [ ] Comments are current. `find_symbol` the commented code and read both together — a comment contradicting its code is `Medium`; cross-reference `consistency.md`.
- [ ] Workarounds record why they exist and what would let them be removed. `search_code` for `workaround`/`hack`/`XXX` and check each has an adjacent explanation — an unexplained workaround is permanent by default.
- [ ] Deliberate deviations from an obvious approach say so, and say what was traded. `search_code` a non-obvious implementation choice (a manual loop where a library call would be idiomatic) and check for a comment explaining the tradeoff. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)

## Maintenance

- [ ] Something keeps docs honest — a test asserting required sections, a link check, or executable examples. `search_code` the CI config and test directory for a docs-lint, link-check, or doctest step; its absence means docs decay silently. Documentation paths (README, `docs/`) should be gated by the same review path as code — a CODEOWNERS entry or branch-protection rule names a reviewer for them; `search_code` for CODEOWNERS and branch-protection/CI config referencing doc paths, and treat code paths with an owner but doc paths without one as the gap. Rule out a project below the size where CODEOWNERS/branch protection is used for code at all — confirm code paths themselves have no reviewer gate either before treating the doc paths' lack of one as a gap rather than a baseline. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html; Write the Docs community, official guide — https://www.writethedocs.org/guide/)
- [ ] Onboarding docs name an owner, or are recent enough to trust. Read the doc's header/footer for an owner or last-updated marker; if absent and `Repo History` is in the confirmed module set, use the file's last-commit date as a proxy for trust. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)
- [ ] Where specs, plans, or ADRs exist, they reflect what shipped. `find_symbol` the component the spec describes and diff its real shape against the spec's. Cross-reference `prompt-spec-gap.md`; a plan describing a design the code abandoned actively misleads. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 10 — https://abseil.io/resources/swe-book/html/ch10.html)

## Out of static reach

- Whether a reader actually succeeds following the docs, versus the steps being present and in the right order — closed by `runtime.md`'s install/typecheck/lint/build/test exit codes when execution is enabled and the declared commands match the documented ones; cite the exit code rather than re-deriving. With browser observation enabled and a documented UI flow among the confirmed flows, the UI-described half of this gap is closed by `browser.md`'s bundle instead — CLI/install steps stay closed by `runtime.md`; steps described as clicks, menus, or screens are closed by a walked flow (see "What browser observation closes" below).
- Whether an in-code comment's rationale is still true today, when nothing pins it to the constraint it described.
- Perceived clarity of an error message or doc passage to someone unfamiliar with the codebase.
- Whether the docs owner named in a header is still the right person to ask.
- Whether this project's own issue tracker, mailing list, or Stack Overflow already contains a documentation complaint matching a finding here — this module has no probe that reads those sources.
- Whether the process a CONTRIBUTING or SECURITY file describes is the process actually followed — this module reads the promise, not the track record.
- Whether readers are actually better served by the four-mode split versus how the docs were organized before — this module confirms the modes exist, not that the split helped.
- A GitHub/GitLab Releases page — it is not in the indexed repository and no probe in this module's catalogue reaches it; a CHANGELOG/HISTORY file in-repo is what `search_code` can confirm.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` / `screenshots/` / `a11y-snapshot.md` | A documented UI flow's steps (menu names, button labels, page order) confirmed against a walked flow covering the same path — refuted if the walked URL/step sequence took a different path to a similar end state, not the same documented path | High |
| `console.jsonl` / `screenshots/` / `steps.md` | Documented failure-mode text matches what actually renders on the walked flow's invalid-input step — refuted if the difference is only in a dynamic value (a filename, a count), not the message template itself | Medium |

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
| README opening missing one of the five stated elements (what/why/how to start/where to help/who maintains), no reason given | Medium |
| Security policy absent for a project accepting external contributions or exposing a network entry point | Medium |
| CONTRIBUTING file absent or its described process does not match actual CI config | Medium |
| Documented UI flow step not reproduced, or a rendered control's label mismatched, in a walked flow | High |
| One of the four Diátaxis modes entirely absent where the project needs it | Low |
| Reference material that only makes sense with tutorial context read first | Low |
| Unexplained workaround | Low |
| Same thing documented in two places | Low |
| No enforcement keeping docs honest | Low |
| No CHANGELOG/release notes, or entries not dated and grouped by type | Low |
| Doc paths (README, `docs/`) excluded from the reviewer/CODEOWNERS gate that covers code paths | Low |
