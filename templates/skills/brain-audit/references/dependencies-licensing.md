# Dependencies & Licensing

Gate: a lockfile or dependency manifest was detected.

Two questions: is each dependency worth its cost, and are you allowed to ship it? Lifecycle scripts, lockfile-integrity attacks (dependency confusion, typosquatting), SBOM, and provenance — OWASP Top 10:2025's A03 "Software Supply Chain Failures" — are `supply-chain.md`'s territory — this module stops at whether a dependency is declared, used, licensed, and current, and does not repeat that work.

## Declared vs. used

Both directions, and both matter — this is the `reachability.md` inverse-gap check applied to the manifest.

- [ ] Declared but never imported. Dead weight in the install, and an attack surface for nothing. `search_code` each package name to confirm.
- [ ] **Imported but not declared.** Resolving today only because a transitive dependency hoisted it; the next lockfile update breaks the build or, worse, production. `search_code` each top-level import against the manifest — rule out inline: language builtins and core modules (`fs`, `path`, `os`, `net`, and their equivalents) are not dependencies, exclude them before flagging. This is `High`.
- [ ] Runtime dependencies sitting in the dev section — fails only for consumers. Read the manifest's `dependencies` vs `devDependencies`, cross-check every runtime-imported package against the section it's declared in. Cross-reference `packaging.md`.
- [ ] Dev dependencies imported by runtime code. `search_code` runtime source files — excluding test and build directories — for imports of packages declared only under `devDependencies`.

## Weight

- [ ] Large dependencies used for a fraction of their surface. For each suspect dependency, `search_code` how many distinct exports are actually imported; name the specific function used and cite `file:line`, not just the dependency name.
- [ ] Dependencies that duplicate the standard library or the runtime. `search_code` the import list against the language's builtins — a padding or deep-clone library where the runtime already ships one is the concrete case.
- [ ] Multiple packages solving the same problem — two date libraries, two HTTP clients, two validation libraries. Cross-check the manifest for known-overlapping categories, name the specific packages found, then `search_code` each one's actual call sites — a decommissioned one still imported somewhere is the migration nobody finished. Pick one; the other is dead weight with a name.
- [ ] Duplicate versions of the same package in the lockfile. Read the lockfile for multiple resolved versions of one package name — bloat, and a source of "instanceof fails across copies" bugs.

## Health

Live CVE and exploitability status needs a registry query this module cannot make and goes stale the moment it's written down — that belongs under Out of static reach, not here. What is checkable from source is whether the project has a *process* for staying current.

- [ ] Declared update process. `search_code` for `renovate.json`, `.github/dependabot.yml`, or a documented update cadence in `CONTRIBUTING` — the same signal OpenSSF Scorecard's `Dependency-Update-Tool` check looks for. Its absence means updates are ad hoc, and the first one will be a forced multi-major jump across the whole tree at once.
- [ ] Version gap as a staleness signal. Read the manifest's declared range against the lockfile's actually-resolved version for each critical-path dependency — a large gap between what's allowed and what's installed is a signal worth naming, but true maintenance status (last release, open-issue backlog, archival) needs the registry and belongs under Out of static reach.
- [ ] Audit step in CI. `search_code` the pipeline for `npm audit`, `pip-audit`, `osv-scanner`, or an equivalent step — cross-reference `devops.md`. Confirm the process exists; do not cite a specific advisory from here, that's a live lookup this module doesn't make.
- [ ] Single-maintainer packages on the critical path. Not a defect, but a risk worth naming when found — Read the manifest's declared critical dependencies for a known single-maintainer project. This approximates what OpenSSF Scorecard's `Maintained` and `Contributors` checks measure directly against live registry and commit data; without that data, name the package and let the reader verify.

## Version discipline

- [ ] Lockfile present and committed — owned by `supply-chain.md` (`get_architecture` packageManager, then confirm the lockfile file itself is tracked and `.gitignore` does not exclude it); reuse its finding, do not re-report.
- [ ] Ranges are deliberate. Read each *runtime* dependency's version specifier — `^`, `*`, or no pin at all accepts breaking changes automatically and is the finding. Rule out inline: the same pattern on a devDependency carries materially lower risk since it never ships; note the distinction rather than flagging both at the same severity.
- [ ] Pins with a comment explaining a workaround. `search_code` for comments like "pinned because" or "TODO remove pin" near a version pin, then check whether the constraint they describe still holds. Cross-reference `future.md`.
- [ ] Something updates dependencies on a cadence — the same `search_code` check for `renovate.json`/`.github/dependabot.yml`/a documented cadence made under Health above; cross-reference it rather than re-checking.

## Licensing

- [ ] Every dependency's license is known, including transitive ones. Read the manifest/lockfile license fields, or a generated license report if one exists in-repo — a checked-in SBOM (CycloneDX ≥1.0, whose per-component license field has existed since the spec's first release, or SPDX, whose Concluded/Declared License fields long predate the 2.3 baseline commonly cited today) counts as this report — and flag any `UNKNOWN` or missing entry. Unknown is not the same as permissive.
- [ ] No license incompatible with how this project ships. Read each declared license found above and name the specific obligation it carries — GPL requires derivative-works disclosure, for instance — checked against the project's own declared license and its shipping model (proprietary vs. open, distributed vs. SaaS). Flag the obligation; do not give a legal verdict.
- [ ] The project's own declared license matches the file it ships and the headers in its source. Read the `LICENSE` file, compare it against the manifest's `license` field and any source header block.
- [ ] Attribution requirements are met where licenses require notices. `search_code` for a `NOTICE` or `THIRD_PARTY_LICENSES` file; confirm one exists when any dependency's license requires it.
- [ ] Vendored or copy-pasted third-party code retains its original license and attribution. `search_code` for `Copyright` strings inside `vendor/`, `third_party/`, or other copied directories.

## Out of static reach

- Live vulnerability and exploitability status of any dependency — registry-dependent, and stale the moment it's recorded.
- Actual maintenance activity and community health of a dependency — last release date, issue-response time, contributor count — needs registry or GitHub API data.
- Whether a copyleft obligation has actually been triggered by how the code is combined and distributed — needs legal judgement, not a source read.
- Real bundle-size impact of a heavy dependency — needs a build to measure, closed by `runtime.md`'s declared build step when execution is enabled.
- Whether a vendored license notice is legally sufficient — the file existing is checkable; its adequacy is not.

## Severity guidance

| Situation | Severity |
|---|---|
| Imported package absent from the manifest | High |
| No declared process for staying current (no Renovate/Dependabot, no audit step in CI) | High |
| Runtime dependency in the dev section | High |
| Vendored third-party code with attribution stripped | High |
| Dependency carries an obligation the project's shipping model may not satisfy | Medium |
| Large version gap between allowed range and resolved version on a critical-path dependency | Medium |
| Single-maintainer package on the critical path | Medium |
| Unknown license on any dependency | Medium |
| Floating major version on a runtime dependency | Medium |
| Two packages solving the same problem | Low |
| Declared but never imported | Low |
