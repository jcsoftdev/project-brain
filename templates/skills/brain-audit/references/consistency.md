# Consistency

Does the codebase agree with itself? Inconsistency is cheap to live with and expensive to work in: every inconsistency is a decision the next reader has to make again.

The method here is comparison, not judgement. Find the dominant pattern with `search_code`, then find the deviations. **The dominant pattern is the standard, even if you would have chosen differently** — do not report the majority as wrong because of personal preference.

## Naming

- [ ] Casing conventions per kind of thing (files, functions, types, constants, config keys) — `search_code` a sample of declarations for each kind, tally the casing style, and treat whichever covers the large majority as the standard. List every declaration using the other style.
- [ ] The same concept has the same name everywhere — `search_code` each candidate synonym (`user` / `account` / `member` for one entity) and compare hit counts. The minority name is the deviation, not automatically wrong, but it is a second mental model for one thing.
- [ ] Opposite operations use symmetric names — `search_code` one half of a known pair (`open`) and check whether its counterpart in the same module is `close` or something asymmetric like `dispose`.
- [ ] Boolean names read as assertions — `search_code` boolean-typed declarations or props; count how many use an `is`/`has`/`can` prefix versus a bare noun, and list the noun-named minority.
- [ ] Abbreviations are used consistently or not at all — `search_code` a common abbreviation (`cfg`, `ctx`, `mgr`, `req`/`res`) alongside its spelled-out form; whichever wins the majority is the convention.

## Structure

- [ ] Files are organised by one principle, not two competing ones — `list_modules` (or read the top-level tree) and check whether the split is consistently by type (`controllers/`, `models/`) or consistently by feature (`billing/`, `auth/`). A tree mixing both is the finding.
- [ ] Similar things live in similar places — for a handful of same-role files (every route handler, say), `search_code` their directory pattern and confirm they land in the same shape of path.
- [ ] Module entry points are consistent — `search_code` for `index.ts`/`index.js` re-export barrels versus deep imports (`from '../foo/bar'`) reaching past a barrel that exists; tally which style dominates.
- [ ] Test file location and naming follow one rule — `search_code` for `.test.`, `.spec.`, and a co-located-vs-`__tests__/`-directory split. The minority pattern is the deviation.

## Idioms

- [ ] One way to do each recurring thing: error creation, logging, config reading, async style, validation — `search_code` each candidate (`new Error(`, a custom error factory, `console.log` vs. the logger import, `process.env.` vs. a config module) and tally which one the codebase actually uses.
- [ ] Async style is uniform — `search_code` for `.then(`, `async function`/`await`, and callback-style signatures (`(err, data) =>`) doing comparable work. Mixed styles for the same kind of operation forces the reader to context-switch.
- [ ] Error handling shape is uniform — `search_code` for `throw new` versus a return-result shape (`{ ok: false`, `Result<`, `[error, data]`). A codebase using both for the same kind of failure has two error-handling mental models live at once.
- [ ] Data validation happens at consistent boundaries — `search_code` the validation library's call sites (`.parse(`, `.validate(`) and note whether they cluster at the route/entry layer or are scattered three layers deep in some services and not others.
- [ ] Immutability conventions are consistent — `search_code` for mutating methods (`.push(`, `.splice(`, `+=` on a declared `const` object) against the dominant style found elsewhere. If most code avoids mutation, the places that mutate need a reason.

## Interfaces

- [ ] Functions with the same role have the same signature shape — `find_symbol` a handful of same-role functions (every repository `findBy*`, say) and diff their parameter shape: options object vs. positional, sync vs. async, same parameter order.
- [ ] Return shapes are consistent for the same kind of operation — `find_symbol` the same set and compare return types; a mix of throwing and returning `null` for "not found" across otherwise-identical functions is the deviation. Cross-reference the output-correctness check in `functional.md`.
- [ ] Null vs. undefined vs. empty-collection means the same thing throughout — `search_code` for `=== null`, `=== undefined`, and `.length === 0` used as "nothing here" checks across different modules; if all three appear for the same semantic case, the meaning has drifted.
- [ ] Optional parameters appear in the same position and default the same way — `find_symbol` the same function set and compare where the optional parameter sits and what its default is.

## Documentation and comments

- [ ] Comment style and density are uniform — `search_code` the doc-comment marker (`/**`, `///`) and compare its count against the number of exported symbols from `find_symbol`. Partial coverage across an otherwise-documented module reads as intentional gaps, which is worse than no documentation at all.
- [ ] The documentation format is one format — `search_code` for competing doc styles (JSDoc blocks vs. plain `//` prose vs. a separate doc generator's syntax) and confirm one wins.
- [ ] Comments are current — for any comment making a factual claim about behaviour ("closes the connection", "always returns non-null"), read the code directly beneath it and confirm the claim still holds. A comment contradicting its code is `Medium` — readers trust comments, and this one lies. This is exactly how the "Close without binding" comment in this repo's own HTTP test came to mislead.

## Tooling agreement

- [ ] Formatter and linter config exist and the codebase actually conforms — read the lint config's enabled rules, then `search_code` for a pattern one of those rules should have caught (`console.log` if `no-console` is on, say). A hit means the config is decoration. (As of 2026 the common combinations are Ruff for Python — largely displacing the older flake8/pylint/isort stack — and ESLint+Prettier or the newer single-tool Biome for JS/TS; the check here is that one combination was picked and enforced, not which.)
- [ ] Committed config does not contradict itself — read `.editorconfig`, the formatter config, and the linter config side by side for the same setting (indent size, quote style, line length) and diff the values.
- [ ] Pre-commit or CI enforces what the config declares — `search_code` for a pre-commit hook (`.husky/`, `.pre-commit-config.yaml`) and a lint/format step in the CI workflow files. Treat the two differently: a pre-commit hook with no matching CI step is enforced only for a developer who has the hook installed and hasn't bypassed it (`--no-verify`, or a fresh clone before the install step ran) — nothing stops a violation from merging. CI absent is the real gap; pre-commit absent with a CI lint step present is slower feedback, not a missing gate. Neither present means the standard is optional, and optional standards decay.

## Out of static reach

- Whether the dominant pattern is the one the team actually intends, versus an accident of who wrote the most code first.
- Whether an inconsistency genuinely confuses contributors in practice, versus being merely aesthetic.
- Comment accuracy for logic whose correctness cannot itself be verified by reading alone (cross-reference the tier ceiling on `inferred` findings).
- Whether a linter rule that exists but isn't enforced in CI is disabled locally by individual developers, or genuinely never runs at all.
- The historical intent behind a deviation — a file that breaks the pattern on purpose, with the reason recorded only in a closed PR discussion this audit cannot read.

## Severity guidance

| Situation | Severity |
|---|---|
| Comment that contradicts its code | Medium |
| One concept under several names | Medium |
| Mixed async styles for the same operation kind | Medium |
| Inconsistent meaning of null / undefined / empty | Medium |
| Two competing file-organisation principles | Low |
| Formatter config that nothing enforces | Low |
| Casing convention drift | Low |
