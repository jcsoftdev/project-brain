# Consistency

Does the codebase agree with itself? Inconsistency is cheap to live with and expensive to work in: every inconsistency is a decision the next reader has to make again.

The method here is comparison, not judgement. Find the dominant pattern with `search_code`, then find the deviations. **The dominant pattern is the standard, even if you would have chosen differently** — do not report the majority as wrong because of personal preference.

## Naming

- [ ] Casing conventions per kind of thing (files, functions, types, constants, config keys) — `search_code` a sample of declarations for each kind, tally the casing style, and treat whichever covers the large majority as the standard. List every declaration using the other style. Naming-convention adoption *consistency* differs sharply by language community: camelCase/PascalCase dominate and Hungarian notation is declining, but how uniformly a codebase actually applies its own nominal convention varies by ecosystem (empirical study of 48 open-source Java/C/C++ projects, arXiv preprint, 2014, https://arxiv.org/abs/1401.5300); Google's own style guide prescribes a specific casing per kind of identifier in one table — modules/functions/variables `lower_with_under`, classes `CapWords`, constants `CAPS_WITH_UNDER` (Google, Google Python Style Guide, official vendor/OSS style guide, current, https://google.github.io/styleguide/pyguide.html) — the same "one rule per kind of thing" shape this check verifies.
- [ ] The same concept has the same name everywhere — `search_code` each candidate synonym (`user` / `account` / `member` for one entity) and compare hit counts. The minority name is the deviation, not automatically wrong, but it is a second mental model for one thing.
- [ ] Opposite operations use symmetric names — `search_code` one half of a known pair (`open`) and check whether its counterpart in the same module is `close` or something asymmetric like `dispose`.
- [ ] Boolean names read as assertions — `search_code` boolean-typed declarations or props; count how many use an `is`/`has`/`can` prefix versus a bare noun, and list the noun-named minority.
- [ ] Abbreviations are used consistently or not at all — `search_code` a common abbreviation (`cfg`, `ctx`, `mgr`, `req`/`res`) alongside its spelled-out form; whichever wins the majority is the convention. Google's own guidance: "do not use abbreviations that are ambiguous or unfamiliar to readers outside your project, and do not abbreviate by deleting letters within a word" (Google, Google Python Style Guide, official vendor/OSS style guide, current, https://google.github.io/styleguide/pyguide.html).

## Structure

- [ ] Files are organised by one principle, not two competing ones — `list_modules` (or read the top-level tree) and check whether the split is consistently by type (`controllers/`, `models/`) or consistently by feature (`billing/`, `auth/`). A tree mixing both is the finding.
- [ ] Similar things live in similar places — for a handful of same-role files (every route handler, say), `search_code` their directory pattern and confirm they land in the same shape of path.
- [ ] Module entry points are consistent — `search_code` for `index.ts`/`index.js` re-export barrels versus deep imports (`from '../foo/bar'`) reaching past a barrel that exists; tally which style dominates.
- [ ] Test file location and naming follow one rule — `search_code` for `.test.`, `.spec.`, and a co-located-vs-`__tests__/`-directory split. The minority pattern is the deviation.

## Idioms

- [ ] One way to do each recurring thing: error creation, logging, config reading, async style, validation — `search_code` each candidate (`new Error(`, a custom error factory, `console.log` vs. the logger import, `process.env.` vs. a config module) and tally which one the codebase actually uses.
- [ ] Async style is uniform — `search_code` for `.then(`, `async function`/`await`, and callback-style signatures (`(err, data) =>`) doing comparable work. Mixed styles for the same kind of operation forces the reader to context-switch.
- [ ] Error handling shape is uniform — `search_code` for `throw new` versus a return-result shape (`{ ok: false`, `Result<`, `[error, data]`). A codebase using both for the same kind of failure has two error-handling mental models live at once. Microsoft's own REST API Guidelines mandate a single error shape precisely so callers "write one piece of code that handles errors consistently" instead of per-endpoint logic (Microsoft, Microsoft REST API Guidelines, official framework/vendor documentation, current, https://github.com/microsoft/api-guidelines/blob/master/Guidelines.md); inconsistent error text for the same failure class is not only a readability cost, it can leak information — "even when error messages don't provide a lot of detail, inconsistencies in such messages can still reveal important clues on how a site works," the canonical example being "file not found" versus "access denied" disclosing that a restricted file exists (OWASP Foundation, official OWASP Community Page, current, https://owasp.org/www-community/Improper_Error_Handling).
- [ ] For error-handling shape inconsistency found above, when the two shapes handle the *same class of caller-facing failure* (authentication, authorization, or resource-existence), name it to `security.md` in addition to `consistency.md`. Compare the actual response text/shape for each path with `search_code`, then `trace_path` (or `find_callers`) from a public entry point to confirm both differing paths are reachable through the same external interface before raising it as an information-disclosure finding rather than a private internal inconsistency — the "file not found" vs. "access denied" disclosure is the canonical instance of this exact defect class (OWASP Foundation, official OWASP Community Page, current, https://owasp.org/www-community/Improper_Error_Handling), and a single API is expected to have one error shape in the first place, which is what makes the divergence notable (Microsoft, Microsoft REST API Guidelines, official framework/vendor documentation, current, https://github.com/microsoft/api-guidelines/blob/master/Guidelines.md). Refuted if the two differing responses are not both reachable by an unauthenticated/unprivileged caller (e.g. one path is admin-only and already assumes trust) — the reachability trace is exactly what rules this out.
- [ ] Data validation happens at consistent boundaries — `search_code` the validation library's call sites (`.parse(`, `.validate(`) and note whether they cluster at the route/entry layer or are scattered three layers deep in some services and not others. Input validation "must be implemented on the server-side before any data is processed," and "as early as possible in the data flow" (OWASP Foundation, OWASP Cheat Sheet Series, official project documentation, current, https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) — the consistent-boundary layer this check verifies is what "as early as possible" looks like in practice.
- [ ] Once the dominant validation-call-site layer is established (e.g. every route handler calls `.parse(`/`.validate(` before its body), run `find_callees` on each sibling entry point at that same layer. An entry point whose callee set contains no validation call, where every sibling at the same layer has one, is a traced absence — report it to `security.md` as an unvalidated boundary, since input validation "must be implemented on the server-side before any data is processed" (OWASP Foundation, OWASP Cheat Sheet Series, official project documentation, current, https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html), not merely to `consistency.md` at the module's default inconsistency severity. Refuted if the entry point's own body performs equivalent checks inline (manual type/shape guards) rather than calling the shared validator — read the body before concluding the boundary is genuinely unvalidated, since the deviation might be idiom drift (back to the plain consistency finding) rather than an actual missing check.
- [ ] Immutability conventions are consistent — `search_code` for mutating methods (`.push(`, `.splice(`, `+=` on a declared `const` object) against the dominant style found elsewhere. If most code avoids mutation, the places that mutate need a reason: check for an adjacent comment or rationale (a perf-critical hot path note, an explicit justification) at the mutating site before flagging it as an unexplained deviation.

## Interfaces

- [ ] Functions with the same role have the same signature shape — `find_symbol` a handful of same-role functions (every repository `findBy*`, say) and diff their parameter shape: options object vs. positional, sync vs. async, same parameter order.
- [ ] Return shapes are consistent for the same kind of operation — `find_symbol` the same set and compare return types; a mix of throwing and returning `null` for "not found" across otherwise-identical functions is the deviation. The same expectation the module already applies to errors — "developers SHOULD be able to write one piece of code that handles [outcomes] consistently" (Microsoft, Microsoft REST API Guidelines, official framework/vendor documentation, current, https://github.com/microsoft/api-guidelines/blob/master/Guidelines.md) — applies equally to return shape. Cross-reference the output-correctness check in `functional.md`.
- [ ] Null vs. undefined vs. empty-collection means the same thing throughout — `search_code` for `=== null`, `=== undefined`, and `.length === 0` used as "nothing here" checks across different modules; if all three appear for the same semantic case, the meaning has drifted.
- [ ] Optional parameters appear in the same position and default the same way — `find_symbol` the same function set and compare where the optional parameter sits and what its default is.

## Documentation and comments

- [ ] Comment style and density are uniform — `search_code` the doc-comment marker (`/**`, `///`) and compare its count against the number of exported symbols from `find_symbol`. Partial coverage across an otherwise-documented module reads as intentional gaps, which is worse than no documentation at all.
- [ ] The documentation format is one format — `search_code` for competing doc styles (JSDoc blocks vs. plain `//` prose vs. a separate doc generator's syntax) and confirm one wins.
- [ ] Comments are current — for any comment making a factual claim about behaviour ("closes the connection", "always returns non-null"), Read the code directly beneath it and confirm the claim still holds. A comment contradicting its code is `Medium` — readers trust comments, and this one lies. This is exactly how the "Close without binding" comment in this repo's own HTTP test came to mislead. Comment-code inconsistency is measurably associated with what comes next: "inconsistent changes are around 1.5 times more likely to lead to a bug-introducing commit than consistent changes," with the effect largest immediately after the drift appears (empirical study using GPT-3.5 + odds-ratio analysis, arXiv preprint, 2024, https://arxiv.org/abs/2409.10781).
- [ ] For a comment flagged above that makes a safety claim about a value ("always returns non-null", "never throws", "closes the connection"), before capping the finding at the module's default `Medium`, run `find_callers` on the commented function; if a caller uses the return value without a null/error check (or without a corresponding cleanup call), the comment is not just stale — it is actively misleading a specific call site, and the finding is `High`, not `Medium`. This is exactly the situation the effect above is largest in: a caller written against the comment's now-false promise, right after the drift starts (empirical study using GPT-3.5 + odds-ratio analysis, arXiv preprint, 2024, https://arxiv.org/abs/2409.10781). Refuted if the caller does have an equivalent guard that is not textually a null-check (e.g. a truthy check, a default-coalescing operator, a try/catch two frames up) — read the caller fully, not just for the literal pattern, before raising.

## Tooling agreement

- [ ] Formatter and linter config exist and the codebase actually conforms — read the lint config's enabled rules, then `search_code` for a pattern one of those rules should have caught (`console.log` if `no-console` is on, say). A hit means the config is decoration. (As of 2026 the common combinations are Ruff for Python — largely displacing the older flake8/pylint/isort stack — and ESLint+Prettier or the newer single-tool Biome for JS/TS; the check here is that one combination was picked and enforced, not which.)
- [ ] Committed config does not contradict itself — Read `.editorconfig`, the formatter config, and the linter config side by side for the same setting (indent size, quote style, line length) and diff the values.
- [ ] Pre-commit or CI enforcement of what the config declares — owned by `tooling-baseline.md` (`search_code` for a pre-commit hook and a matching lint/format step in the CI workflow, and confirm the CI step actually gates the merge rather than running only pre-commit); reuse its finding, do not re-report.

## Documented vs accidental deviation

- [ ] Before reporting a naming, structural or idiom deviation as an unexplained inconsistency, `search_code` the deviating file for a `TODO`/`FIXME`/`HACK`/`XXX` comment naming that specific deviation. A marker turns the finding from "accidental drift" into "documented debt" — report both, but cap the documented case at `Low` regardless of what the table below would otherwise assign; documented is not the same as intentionally scoped or already scheduled to be fixed. Refuted if a `TODO` found in the file names something unrelated to the specific deviation (e.g. a `TODO` about a missing test, on a file that also happens to have inconsistent casing) — the marker must reference the same deviation, not merely be present in the file.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Everything else in this module — casing, file organisation, idiom uniformity, interface signature shape, comment format, tooling config — is a property of the source tree itself, not of rendered runtime behaviour, so a browser session run against the built app cannot observe it. Only the subset that becomes user-facing text at render time (labels, error copy) crosses from source into something the bundle can corroborate.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `screenshots/`, `steps.md`, `final-state.md` (rendered label text) | User-facing terminology drift for the same action across screens (e.g. one flow's button says "Delete", another's says "Remove" for the same operation) — only visible once labels are rendered, not from a static JSX string grep when text is interpolated/i18n-keyed. Refuted if the two actions are not actually the same operation (one is a soft-delete/archive, the other a hard delete) — read `steps.md`'s recorded outcome for each flow before treating the words as interchangeable. | Low |
| `network.jsonl` (response bodies), `console.jsonl`, `final-state.md` | Runtime error text shown to the user for the same failure class differs between two flows, corroborating the error-text-inconsistency check above — parallel to it, now at `observed` since the browser session itself proves both are reachable in one signed-in context, without needing the `trace_path` step — with what an actual response body/rendered error state contained rather than only the source string. Refuted the same way: the two flows are not reachable by the same caller privilege level. | High |

## Out of static reach

- Whether the dominant pattern is the one the team actually intends, versus an accident of who wrote the most code first.
- Whether an inconsistency genuinely confuses contributors in practice, versus being merely aesthetic.
- Comment accuracy for logic whose correctness cannot itself be verified by reading alone (cross-reference the tier ceiling on `inferred` findings).
- Whether a linter rule that exists but isn't enforced in CI is disabled locally by individual developers, or genuinely never runs at all.
- The historical intent behind a deviation — a file that breaks the pattern on purpose, with the reason recorded only in a closed PR discussion this audit cannot read.
- Whether this project's names agree with a sibling repository's names for the same concept — this audit indexes one repository.
- Whether an internal name matches how the business describes the same concept outside the codebase — this audit has no access to product or support documentation.
- Who or what introduced a given deviation, and whether it was a deliberate choice — cross-reference `repo-history.md` if that module ran.

## Severity guidance

| Situation | Severity |
|---|---|
| Comment that contradicts its code, and an unguarded caller relies on the false claim, traced via `find_callers` | High |
| Inconsistent error text/shape for the same failure class, reachable from the same external interface (traced) | High |
| Entry point missing the shared validation call every sibling at its layer has, traced via `find_callees` | High |
| Comment that contradicts its code | Medium |
| One concept under several names | Medium |
| Mixed async styles for the same operation kind | Medium |
| Inconsistent meaning of null / undefined / empty | Medium |
| Two competing file-organisation principles | Low |
| Formatter config that nothing enforces | Low |
| Casing convention drift | Low |
| Deviation with a `TODO`/`FIXME`/`HACK` marker naming it (documented, not accidental) | Low |
