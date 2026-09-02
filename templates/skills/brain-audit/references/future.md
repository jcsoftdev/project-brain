# Future

What will hurt six months from now? This module is forward-looking, which makes it the easiest place to invent findings. Every item here must point at code that exists today.

## Extension points

- [ ] Where the project clearly expects to grow (new providers, new commands, new file types), is adding one a single-file change or a shotgun edit? `find_callers` on the dispatcher/registry to count the places a new case must be registered.
- [ ] Hardcoded lists that will need an entry per future addition — a switch, a `Set` of names, a manual manifest. `search_code` the list/switch, then `find_callers` it to check whether a parity test asserts it stays in sync with any sibling list. Not automatically wrong; flag the ones with no guard.
- [ ] Interfaces with exactly one implementation. `search_code`/`find_callers` the interface name for implementing classes. Rule out a test-only mock or stub before counting it as the second implementation. Exactly one real implementation means either the abstraction is speculative or a second is coming — say which you think it is, and why.

## Scaling assumptions

- [ ] Loops and data structures that assume small N. `search_code` for an unbounded loop over a collection loaded in full — no pagination, no cursor, no `LIMIT`. Read what actually bounds N: a config value, user input, or nothing.
- [ ] Anything loaded fully into memory: whole files, whole tables, whole directories. `search_code` for `readFile`/`SELECT *`/`readdir` with no streaming or pagination counterpart. State the input size at which it breaks.
- [ ] Synchronous work on a path that will eventually be called in a loop. `find_callers` the synchronous function. Rule out a caller whose own loop bound is small and fixed (an enum, a constant-size config) before flagging it — that is present-tense, not future.

## Lock-in

- [ ] Dependencies on a specific vendor, model, API version, or file format, with no adapter layer. `search_code` the vendor SDK import, then `find_callers` it to check whether call sites route through one seam or are scattered directly through the codebase. Note the switching cost either way.
- [ ] Data formats written to disk with no version field — owned by `versioning-compatibility.md` (`search_code`/`find_symbol` the schema or serialisation definition for a `version`/`schemaVersion`/`_v` field); reuse its finding, do not re-report. This module's own angle is the migration-cost consequence, covered by the next check.
- [ ] Persisted state whose schema has no migration path. `search_code` a migrations directory or schema-versioning table; its absence next to a persisted, evolving shape is the finding.

## Deprecation debt

Ownership split with `versioning-compatibility.md`: this module asks whether the architecture is ready to grow (a duplicated "old way"/"new way" code path, an API kept around with no removal date, as a design-health question); `versioning-compatibility.md` asks the same kind of fact framed as a compatibility promise to a consumer — is a deprecated symbol still exercised, does a stated timeline have a removal version. The two checks can point at the same code from different angles; do not double-count.

- [ ] APIs, flags, or config keys kept for backwards compatibility with no removal date and no deprecation warning. `search_code` for `deprecated` in comments/docstrings and check each for a stated removal version or date. Absence means it will be kept forever by default.
- [ ] Duplicated code paths where one is "the old way" — `find_callers` the old path. If it still has callers, the migration is unfinished; if not, it is dead and belongs to `Reachability`, not here.
- [ ] Pinned dependency versions with a comment explaining a workaround. `search_code` the pin in the manifest and read the adjacent comment. Verify, where a linked issue exists, whether it is still open before assuming the workaround is stale.

## What NOT to report here

Speculative refactors, "this could be more generic", and architecture preferences with no concrete future cost. If you cannot name the change that will be painful and the code that makes it painful, it is not a finding — it is taste.

## Out of static reach

- Whether an extension point will actually be exercised again, versus built once and never revisited.
- Whether a switching cost for a locked-in vendor is tolerable to the team — that is a business judgement, not a structural one.
- The actual size N a scaling assumption breaks at under production traffic, as opposed to the shape of the code.
- Whether a pinned dependency's linked workaround issue has since been fixed upstream, when the repo carries no link to check.

## Severity guidance

| Situation | Severity |
|---|---|
| Extension requires a shotgun edit across many files with no registry | Medium |
| Unbounded loop or full-memory load with no stated bound | Medium |
| Vendor/format lock-in with no adapter seam | Medium |
| Persisted state with no migration path | Medium |
| Deprecated API/flag with no removal date | Low |
| Duplicated "old way" path confirmed dead (report under `Reachability`) | Low |
| Hardcoded list with no parity guard | Low |
| Pinned dependency workaround unverified as still needed | Low |
