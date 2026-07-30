# Consistency

Does the codebase agree with itself? Inconsistency is cheap to live with and expensive to work in: every inconsistency is a decision the next reader has to make again.

The method here is comparison, not judgement. Find the dominant pattern with `search_code`, then find the deviations. **The dominant pattern is the standard, even if you would have chosen differently** — do not report the majority as wrong because of personal preference.

## Naming

- [ ] Casing conventions per kind of thing (files, functions, types, constants, config keys) — one convention each, or a stated reason for more.
- [ ] The same concept has the same name everywhere. `user` / `account` / `member` for one entity is three mental models.
- [ ] Opposite operations use symmetric names: `open`/`close`, not `open`/`dispose`.
- [ ] Boolean names read as assertions — `isReady`, `hasItems` — not as nouns.
- [ ] Abbreviations are used consistently or not at all.

## Structure

- [ ] Files are organised by one principle, not two competing ones (by type in one place, by feature in another).
- [ ] Similar things live in similar places. A new contributor should be able to guess where a file goes.
- [ ] Module entry points are consistent — barrel file or direct import, one or the other.
- [ ] Test file location and naming follow one rule.

## Idioms

- [ ] One way to do each recurring thing: error creation, logging, config reading, async style, validation.
- [ ] Async style is uniform. Mixed callbacks, promises, and async/await for the same kind of operation forces the reader to context-switch.
- [ ] Error handling shape is uniform — throw vs. return-result, chosen once.
- [ ] Data validation happens at consistent boundaries, not sometimes at the edge and sometimes three layers in.
- [ ] Immutability conventions are consistent — if most code avoids mutation, the places that mutate need a reason.

## Interfaces

- [ ] Functions with the same role have the same signature shape — options object vs. positional, sync vs. async, same parameter order.
- [ ] Return shapes are consistent for the same kind of operation. Cross-reference the output-correctness check in `functional.md`.
- [ ] Null vs. undefined vs. empty-collection means the same thing throughout.
- [ ] Optional parameters appear in the same position and default the same way.

## Documentation and comments

- [ ] Comment style and density are uniform. Half the exports documented is worse than none, because the gaps read as intentional.
- [ ] The documentation format is one format.
- [ ] Comments are current. A comment contradicting its code is `Medium` — readers trust comments, and this one lies. This is exactly how the "Close without binding" comment in this repo's own HTTP test came to mislead.

## Tooling agreement

- [ ] Formatter and linter config exist and the codebase actually conforms. A config nothing enforces is decoration.
- [ ] Committed config does not contradict itself (editor settings vs. formatter vs. linter).
- [ ] Pre-commit or CI enforces what the config declares. Otherwise the standard is optional, and optional standards decay.

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
