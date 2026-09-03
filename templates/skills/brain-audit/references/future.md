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

- [ ] Dependencies on a specific vendor, model, API version, or file format, with no adapter layer. `search_code` the vendor SDK import, then `find_callers` it to check whether call sites route through one seam or are scattered directly through the codebase. Note the switching cost either way. When this finding names a vendor/SDK import with no adapter seam, check whether `tooling-baseline.md` (if it ran this session) also flagged that same import as carrying a known CVE or as materially outdated — when both are true, name both angles in the one finding ("switching cost, and it is currently unpatched") instead of reporting them as two separate findings; this module's own severity ceiling is unchanged, the CVE angle is `tooling-baseline.md`'s to score. Not applicable when `tooling-baseline.md` did not run this session — the finding then stands alone with only the switching-cost framing. (OWASP, "A06:2021 – Vulnerable and Outdated Components," OWASP Top 10:2021 — https://owasp.org/Top10/2021/A06_2021-Vulnerable_and_Outdated_Components/index.html)
- [ ] Data formats written to disk with no version field — owned by `versioning-compatibility.md` (`search_code`/`find_symbol` the schema or serialisation definition for a `version`/`schemaVersion`/`_v` field); reuse its finding, do not re-report. This module's own angle is the migration-cost consequence, covered by the next check.
- [ ] Persisted state whose schema has no migration path. `search_code` a migrations directory or schema-versioning table; its absence next to a persisted, evolving shape is the finding.

## Deprecation debt

Ownership split with `versioning-compatibility.md`: this module asks whether the architecture is ready to grow (a duplicated "old way"/"new way" code path, an API kept around with no removal date, as a design-health question); `versioning-compatibility.md` asks the same kind of fact framed as a compatibility promise to a consumer — is a deprecated symbol still exercised, does a stated timeline have a removal version. The two checks can point at the same code from different angles; do not double-count.

- [ ] APIs, flags, or config keys kept for backwards compatibility with no removal date and no deprecation warning. `search_code` for `deprecated` in comments/docstrings and check each for a stated removal version or date. Absence means it will be kept forever by default. (Winters, Manshreck & Wright, eds., *Software Engineering at Google*, ch. 15 — https://abseil.io/resources/swe-book/html/ch15.html)
- [ ] Duplicated code paths where one is "the old way" — `find_callers` the old path. If it still has callers, the migration is unfinished; if not, it is dead and belongs to `Reachability`, not here. When `find_callers` returns live callers, name the count and whether they cluster (one remaining caller reads as a near-complete migration; many scattered callers reads as a stalled one). A stalled migration with no tracking issue referenced nearby (`search_code` for a ticket-ID pattern near the old path) is deprecation debt in its own right, not merely "unfinished" — a small, non-growing set of remaining callers with an open, actively referenced tracking issue nearby is a healthy in-progress migration, not a finding, once that reference is confirmed. (Fowler, "StranglerFigApplication," martinfowler.com bliki — https://martinfowler.com/bliki/StranglerFigApplication.html)
- [ ] Pinned dependency versions with a comment explaining a workaround. `search_code` the pin in the manifest and read the adjacent comment. Verify, where a linked issue exists, whether it is still open before assuming the workaround is stale. (OWASP, "A06:2021 – Vulnerable and Outdated Components," OWASP Top 10:2021 — https://owasp.org/Top10/2021/A06_2021-Vulnerable_and_Outdated_Components/index.html)
- [ ] `search_code` + `Read` the declared runtime/language version pin (`package.json` "engines", `.nvmrc`, `Dockerfile` `FROM node:<major>`, `go.mod` `go <version>`, `pyproject.toml` `python_requires`) at file:line and name the exact pinned major version in the finding. State only what was read — do not assert a specific external EOL date from memory; that comparison is outside this module's probe catalogue and belongs in Coverage Gaps. The pin may be a floor (`>=`) rather than a ceiling, so a newer runtime is already used in CI/deploy — check CI workflow files via `search_code` for the actual runtime matrix before treating a floor pin as stale. (endoflife.date, "Node.js" — https://endoflife.date/nodejs; Node.js Release Working Group, README — https://raw.githubusercontent.com/nodejs/Release/main/README.md)

## Self-admitted debt signals

- [ ] `search_code` for `TODO|FIXME|HACK|XXX` comment markers; for each hit that lands inside a construct already flagged by this module's other checks (the loop/collection from Scaling assumptions, the vendor import from Lock-in, the switch/registry from Extension points), `Read` the marker and its surrounding code and cite it as corroborating evidence inside that finding — a bare marker with no other structural signal nearby is not, on its own, a finding here. Confirm on the read that the condition the comment describes is still literally present in the code being cited, not merely nearby — that rules out a marker whose surrounding construct was rewritten since the comment was written. This raises confidence on the check it corroborates rather than opening a new severity row of its own. (Sridharan, Robredo, Rantala, Esposito, Lenarduzzi & Mäntylä, "Hidden in Plain Sight: Where Developers Confess Self-Admitted Technical Debt," arXiv, 2025 — https://arxiv.org/abs/2511.01529)

## What NOT to report here

Speculative refactors, "this could be more generic", and architecture preferences with no concrete future cost. If you cannot name the change that will be painful and the code that makes it painful, it is not a finding — it is taste.

## Out of static reach

- Whether an extension point will actually be exercised again, versus built once and never revisited.
- Whether a switching cost for a locked-in vendor is tolerable to the team — that is a business judgement, not a structural one.
- The actual size N a scaling assumption breaks at under production traffic, as opposed to the shape of the code.
- Whether a pinned dependency's linked workaround issue has since been fixed upstream, when the repo carries no link to check.
- Whether the pinned runtime version is past its EOL today — this module can read and name the pin, not consult the vendor's live calendar; state the version and let the user check it against endoflife.date.
- Whether the architecture has drifted from its original design over time — this module reads one snapshot; drift needs `repo-history.md`'s git history, not a single audit pass.
- Whether a TODO/FIXME still tracks a real, open concern — this module can cite the comment, not confirm the ticket behind it (if any) is still open.
- Whether a forward-looking cost was a deliberate, accepted tradeoff or an accident — this module reads the shape of the risk, not the reasoning (if any) behind accepting it.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `console.jsonl` | A framework or browser deprecation warning fires during a walked flow (e.g. a React/Vue/Angular console notice that an API "is deprecated and will be removed", a browser `Deprecation` console category entry) — refuted if the stack trace/source points at a third-party script the project does not control | Low |
| `console.jsonl` / `steps.md` | A statically-flagged "deprecated, no removal date" API or flag (from this module's own Deprecation debt check) is confirmed still exercised, by observing it fire during a walked flow — refuted if the warning is a dev-mode-only artifact (e.g. React StrictMode's double-invoke warnings) that would not fire in a production build; raises the existing static finding's tier from `read` toward `observed` rather than opening a separate one | No new row — promotes the existing finding's tier |

## Severity guidance

| Situation | Severity |
|---|---|
| Extension requires a shotgun edit across many files with no registry | Medium |
| Unbounded loop or full-memory load with no stated bound | Medium |
| Vendor/format lock-in with no adapter seam | Medium |
| Persisted state with no migration path | Medium |
| Duplicated "old way" path with live callers, scattered, no tracking issue referenced (stalled migration) | Medium |
| Deprecated API/flag with no removal date | Low |
| Duplicated "old way" path confirmed dead (report under `Reachability`) | Low |
| Hardcoded list with no parity guard | Low |
| Pinned dependency workaround unverified as still needed | Low |
| Pinned runtime/language version named against its vendor support clock | Low |
| Lock-in finding also flagged by `tooling-baseline.md` as a known CVE or materially outdated | Info |
