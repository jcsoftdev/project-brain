# Versioning & Compatibility

Gate: a published package manifest or a release workflow was detected.

Every published thing has consumers you cannot see. This module asks whether a consumer who upgrades will survive it.

The gate also fires for a deployed *service* with a release workflow and no package manifest — the discipline transfers with one adjustment. A library's consumers pin a version and choose when to upgrade, so semver's compatibility unit (a versioned public API surface, per [semver.org 2.0.0](https://semver.org/)) applies directly. A service normally has exactly one deployed version running at a time — nobody pins it — so "breaking change" there is really a question of API/endpoint deprecation and sunset discipline (cross-reference `api.md`'s Compatibility section and the Deprecation checks below), not a semver bump on the deployable artefact. Apply the Public-surface and Breaking-change checks below to the service's *API contract* version (`/v1`, a schema version field) rather than to a build number nobody consumes.

## Public surface

- [ ] What is public is stated. `search_code` the manifest's `exports` map, its `main`/`module`/`types` fields, Python's `__all__`, or a dedicated barrel file re-exporting a curated subset. If none exists, that absence is the finding itself — everything exported is public by accident, and every internal rename becomes a breaking change nobody planned for.
- [ ] Internal-only exports are marked internal, or not exported. `find_callers` on each export — one with only in-repo callers is a candidate to unexport; one still called from outside the package is genuinely public and stays.
- [ ] Types and schemas that appear in public signatures are part of the contract, including their optional fields. `find_symbol` each type referenced by an exported function's signature and confirm whether it is itself exported. A type that is structurally reachable through a public function but never separately exported is an accidental contract surface — a consumer can still extract it with `ReturnType`/`Parameters`, even though nobody declared it public.
- [ ] Configuration keys, CLI flags, environment variables, and on-disk formats are public surface too. `search_code` the CLI argument parser or config schema definition, then cross-check each key against the README and CHANGELOG — an undocumented flag is still a promise the moment one consumer starts depending on it, documented or not.

## Breaking-change discipline

- [ ] Version numbers follow a stated scheme, and breaking changes actually bump the breaking component. Read CONTRIBUTING, README, or the manifest itself for a stated semver policy. Under semver 2.0.0 itself, a `0.x` package has made no compatibility promise at all — say so rather than holding it to a discipline it never adopted. Note that an ecosystem's tooling may still layer its own convention on top of the spec's silence (npm and Cargo's default caret range treats `0.x.y` as compatible with `0.x.z` for `y ≥ z`, patch-like) — check the actual range operator consumers use rather than assuming the spec settles it; this is a genuine, unresolved point of disagreement among practitioners, not a mistake to flag on sight.
- [ ] For each recent change to public surface, classify it: added (minor), fixed (patch), removed or narrowed (major). The probe is an actual diff, not memory: `find_symbol` the current exported signature against what the previous git tag's source held, or against the CHANGELOG's own prior entries where tags don't exist, and report any commit whose real diff does not match its claimed classification.
- [ ] These are breaking even when they look small: narrowing an accepted input, adding a required parameter, changing a default, changing an error type, changing a return shape, renaming a config key, tightening validation. Apply this list to every signature the diff above actually touched — a check run with no diff behind it is a guess, not this check.
- [ ] Behavioural breaks count, not only signature breaks. Same types, different meaning is worse — it compiles and misbehaves. This one is necessarily `read`-tier: there is no structural probe for a behaviour change on an identical signature, so read the changelog and PR descriptions for language implying it — "now returns", "previously", "fixed to actually" — and state the lower confidence explicitly in the finding.

## Deprecation

- [ ] Removals are preceded by a deprecation with a runtime warning and a stated replacement. For a library: `search_code` for `@deprecated`, `console.warn(.*deprecat`, `DeprecationWarning`, or the language equivalent, then read whether the warning text names the replacement. For an HTTP API: `search_code` for a `Deprecation` response header being set (RFC 9745 — a Structured Field date, not free text) rather than only a docs mention. Either way, a warning that only says "this is deprecated" gives the consumer nothing to migrate to.
- [ ] Deprecations have a removal version, not just a label. Read the deprecation message or its doc comment for a stated version. For an HTTP API, the removal date is a `Sunset` header (RFC 8594) — a concrete date, not a version label — and RFC 9745 requires it never predate the `Deprecation` header's own date on the same response; `search_code` both header values together and diff them where both are present. Cross-reference `future.md`: an undated deprecation is kept forever.
- [ ] Both paths work during the overlap, and the old one is genuinely equivalent. `find_callers` on the deprecated symbol to confirm it is still exercised — a deprecated path with zero callers cannot regress, but it also means the warning itself is untested. `find_symbol` both the old and new paths and read whether the old one still delegates to working logic or has decayed into a stub returning a stale value.
- [ ] Deprecation warnings are emitted once per process, not once per call. Read the warning call site: is it guarded by a memoised flag, or does it fire unconditionally inside the function body? `find_callers` on the containing function to check whether it sits in a loop or a hot path — an unconditional warning there floods the log and trains consumers to ignore every warning, including the ones that matter.

## Data and state compatibility

- [ ] Persisted formats carry a version field. `search_code`/`find_symbol` the schema or serialisation definition for a `version`, `schemaVersion`, or `_v` field. Without one, the next reader must guess the shape from content alone.
- [ ] The new version reads state written by the previous version. `find_symbol` the deserialisation or migration function and read whether it branches on the version field or assumes the latest shape unconditionally — an unconditional assumption is the finding, not a hypothetical to flag as risk.
- [ ] Forward compatibility is decided deliberately: does an older version encountering newer state fail loudly or corrupt quietly? Read the deserialiser's fallback branch for an unrecognised version. Silently defaulting or coercing is the finding; throwing is the only acceptable answer — and "no fallback branch at all" means it currently throws an unrelated, confusing error rather than a compatibility message, which is its own smaller finding.
- [ ] Migrations of on-disk or cached state are idempotent and recoverable if interrupted. `find_symbol` the migration runner and check whether it tracks applied migrations — a table, log, or marker file — versus re-running everything blindly on every start. No tracking means a crash mid-migration corrupts state on the next boot.

## Runtime and platform

- [ ] Declared engine and platform support matches what the code and dependencies actually require. Read the manifest's `engines` or `python_requires` field, then `search_code` for syntax that needs a newer runtime than declared — optional chaining, top-level `await`, a stdlib call added in a later minor — and cross-check each dependency's own declared minimum against the project's.
- [ ] Minimum supported versions are tested, not just declared. `search_code` the CI workflow's matrix definition for the runtime version list — a matrix of one entry supports one version, regardless of what the manifest promises.
- [ ] Newly used runtime APIs do not silently raise the real minimum below the declared one. `search_code` for recently introduced syntax or stdlib calls and check each against the feature set of the declared minimum version — a single call gated on a newer API narrows support for everyone, whatever the manifest still claims.

## Communication

- [ ] Changes are recorded somewhere a consumer will find — changelog, release notes, or migration guide. `search_code` for `CHANGELOG.md`, `HISTORY.md`, or a release-notes directory, then check whether recent merged PRs or tagged commits have a corresponding entry — an untouched changelog next to an active commit log is the finding.
- [ ] Breaking changes state the migration, not just the fact. Read changelog entries tagged `BREAKING` or attached to a major bump for concrete migration instructions — "X changed" is not the same disclosure as "X changed, do Y instead".
- [ ] Entries correspond to real commits; a changelog nobody maintains is worse than none because it is trusted. Spot-check a handful of recent entries against the actual git log or diff for the version they claim — a description with no matching commit, or a commit with no matching entry, means the changelog has drifted from the source it claims to summarise.

## Out of static reach

- Whether real consumers have actually upgraded, and whether the upgrade succeeded for them.
- Whether a behavioural break is noticed by anyone — that needs usage telemetry or support tickets, not the repository.
- Whether a stated deprecation timeline was honoured in practice, or quietly extended past its own removal version.
- Runtime behaviour on a platform or version combination outside the CI matrix.
- Whether external documentation (a hosted docs site) still matches the in-repo CHANGELOG.

## Severity guidance

| Situation | Severity |
|---|---|
| Breaking change shipped without a breaking version bump | High |
| Behavioural break with an unchanged signature | High |
| New version cannot read the previous version's persisted state | High |
| Persisted format with no version field | High |
| Removal with no prior deprecation | Medium |
| Deprecation with no removal version | Medium |
| `Sunset` header dated earlier than the `Deprecation` header on the same response | High |
| Declared engine support wider than what the code requires | Medium |
| No declared public-surface boundary | Medium |
| Breaking change documented without a migration path | Low |
