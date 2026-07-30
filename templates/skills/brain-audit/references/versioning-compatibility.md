# Versioning & Compatibility

Gate: a published package manifest or a release workflow was detected.

Every published thing has consumers you cannot see. This module asks whether a consumer who upgrades will survive it.

## Public surface

- [ ] What is public is stated. Without a declared boundary, everything exported is public by accident and every internal rename is a breaking change.
- [ ] Internal-only exports are marked internal, or not exported. `find_callers` on each export — one with only in-repo callers is a candidate to unexport.
- [ ] Types and schemas that appear in public signatures are part of the contract, including their optional fields.
- [ ] Configuration keys, CLI flags, environment variables, and on-disk formats are public surface too. These are the ones teams forget.

## Breaking-change discipline

- [ ] Version numbers follow a stated scheme, and breaking changes actually bump the breaking component. A major-version-zero project should say what its stability promise is.
- [ ] For each recent change to public surface, classify it: added (minor), fixed (patch), removed or narrowed (major). Report any misclassification.
- [ ] These are breaking even when they look small: narrowing an accepted input, adding a required parameter, changing a default, changing an error type, changing a return shape, renaming a config key, tightening validation.
- [ ] Behavioural breaks count, not only signature breaks. Same types, different meaning is worse — it compiles and misbehaves.

## Deprecation

- [ ] Removals are preceded by a deprecation with a runtime warning and a stated replacement.
- [ ] Deprecations have a removal version, not just a label. Cross-reference `future.md`: an undated deprecation is kept forever.
- [ ] Both paths work during the overlap, and the old one is genuinely equivalent.
- [ ] Deprecation warnings are emitted once per process, not once per call.

## Data and state compatibility

- [ ] Persisted formats carry a version field. Without one, the next reader must guess.
- [ ] The new version reads state written by the previous version. Test it, do not assume it.
- [ ] Forward compatibility is decided deliberately: does an older version encountering newer state fail loudly or corrupt quietly? Loudly is the only acceptable answer.
- [ ] Migrations of on-disk or cached state are idempotent and recoverable if interrupted.

## Runtime and platform

- [ ] Declared engine and platform support matches what the code and dependencies actually require.
- [ ] Minimum supported versions are tested, not just declared. A CI matrix of one version supports one version.
- [ ] Newly used runtime APIs do not silently raise the real minimum below the declared one.

## Communication

- [ ] Changes are recorded somewhere a consumer will find — changelog, release notes, or migration guide.
- [ ] Breaking changes state the migration, not just the fact.
- [ ] Entries correspond to real commits; a changelog nobody maintains is worse than none because it is trusted.

## Severity guidance

| Situation | Severity |
|---|---|
| Breaking change shipped without a breaking version bump | High |
| Behavioural break with an unchanged signature | High |
| New version cannot read the previous version's persisted state | High |
| Persisted format with no version field | High |
| Removal with no prior deprecation | Medium |
| Deprecation with no removal version | Medium |
| Declared engine support wider than what the code requires | Medium |
| No declared public-surface boundary | Medium |
| Breaking change documented without a migration path | Low |
