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
- [ ] Audit step in CI. `search_code` the pipeline for `npm audit`, `pip-audit`, `osv-scanner`, or an equivalent step — cross-reference `devops.md`. Confirm the process exists; do not cite a specific advisory from here, that's a live lookup this module doesn't make. OWASP Top 10:2025 ranks A03 "Software Supply Chain Failures" #3 of ten categories — an audit step is the process this check closes the loop against.
- [ ] Single-maintainer packages on the critical path. Not a defect, but a risk worth naming when found — Read the manifest's declared critical dependencies for a known single-maintainer project. This approximates what OpenSSF Scorecard's `Maintained` and `Contributors` checks measure directly against live registry and commit data; without that data, name the package and let the reader verify.

## Version discipline

- [ ] Lockfile present and committed — owned by `supply-chain.md` (`get_architecture` packageManager, then confirm the lockfile file itself is tracked and `.gitignore` does not exclude it); reuse its finding, do not re-report.
- [ ] Ranges are deliberate. Read each *runtime* dependency's version specifier — `^`, `*`, or no pin at all accepts breaking changes automatically and is the finding. Rule out inline: the same pattern on a devDependency carries materially lower risk since it never ships; note the distinction rather than flagging both at the same severity. npm docs: `^1.0.4` allows any backward-compatible update past the leftmost non-zero digit, `*`/`x` accepts "changes that break backward compatibility" outright — a caret/wildcard range trusts the upstream author's semver discipline and has no mechanism to enforce it.
- [ ] Pins with a comment explaining a workaround. `search_code` for comments like "pinned because" or "TODO remove pin" near a version pin, then check whether the constraint they describe still holds. Cross-reference `future.md`.
- [ ] Something updates dependencies on a cadence — the same `search_code` check for `renovate.json`/`.github/dependabot.yml`/a documented cadence made under Health above; cross-reference it rather than re-checking.

## Licensing

- [ ] Every dependency's license is known, including transitive ones. Read the manifest/lockfile license fields, or a generated license report if one exists in-repo — a checked-in SBOM (CycloneDX ≥1.0, whose per-component license field has existed since the spec's first release, or SPDX, whose Concluded/Declared License fields long predate the 2.3 baseline commonly cited today) counts as this report — and flag any `UNKNOWN` or missing entry. Unknown is not the same as permissive. SPDX gives each license a standardized short identifier (`MIT`, `GPL-2.0-only`, `Apache-2.0`) "to enable efficient and reliable identification of such licenses and exceptions."
- [ ] For every license identified in the inventory, `search_code` the manifest/lockfile license fields and `Read` the SPDX identifier or bundled license text to confirm whether it is on the OSI-approved list or is a known source-available term (BSL, SSPL, RSAL, Elastic License) — a dependency's own README or marketing copy calling itself "open source" is not evidence. Flag any source-available dependency the same as an unknown license until its specific field-of-use restriction is named. The OSI's own Open Source Definition states plainly: "Open source doesn't just mean access to the source code." Redis's own FAQ is the named, concrete instance of this exact gap: the vendor states its SSPL/RSAL dual license means Redis "is no longer open source under the OSI definition," while the source stays freely downloadable and is still widely assumed "open source" by consumers.
- [ ] No license incompatible with how this project ships. Read each declared license found above and name the specific obligation it carries — GPL requires derivative-works disclosure, for instance — checked against the project's own declared license and its shipping model (proprietary vs. open, distributed vs. SaaS). Flag the obligation; do not give a legal verdict. FSF's GPL FAQ: if you release a modified GPL program, "the GPL requires you to make the modified source code available to the program's users, under the GPL." For each critical-path dependency with a known relicense history (Elasticsearch/Kibana 2021, HashiCorp products 2023, Redis 2024 are the documented precedents — the list will grow), read the manifest-declared range and the lockfile-resolved version against the version the relicense took effect; a resolved version on or after that boundary means the project is bound by the new terms, not the reputation the dependency had when it was first added. Not the finding: the resolved version predates the relicense boundary, or the project's shipping model doesn't trigger the new license's restricted clause (e.g. not a competing managed service under HashiCorp's BSL, not embedding-as-a-service under Redis's RSAL/SSPL).
- [ ] Any dependency licensed AGPL or SSPL is checked for how the project actually uses it: `search_code` for whether it's invoked as an in-process library, a spawned local process, or a networked service the project's own users interact with remotely. AGPL §13 and SSPL's modified §13 both convert the licensed obligation from a distribution trigger to a network-interaction trigger — a modified version must "prominently offer all users interacting with it remotely through a computer network... an opportunity to receive the Corresponding Source" — so a SaaS deployment can owe source disclosure without shipping a single binary. Not the finding: the dependency is consumed only as a client against an externally-operated managed instance (e.g. a hosted Redis Cloud endpoint) that the project itself never modifies or redistributes — no modified version exists for §13 to attach to.
- [ ] The project's own declared license matches the file it ships and the headers in its source. Read the `LICENSE` file, compare it against the manifest's `license` field and any source header block.
- [ ] Attribution requirements are met where licenses require notices. `search_code` for a `NOTICE` or `THIRD_PARTY_LICENSES` file; confirm one exists when any dependency's license requires it.
- [ ] Vendored or copy-pasted third-party code retains its original license and attribution. `search_code` for `Copyright` strings inside `vendor/`, `third_party/`, or other copied directories. The GPL family specifically requires preserving such notices on redistribution (FSF GPL FAQ); this check is broader than GPL, but that is the concrete rule grounding the concern.

## Out of static reach

- Live vulnerability and exploitability status of any dependency — registry-dependent, and stale the moment it's recorded.
- Actual maintenance activity and community health of a dependency — last release date, issue-response time, contributor count — needs registry or GitHub API data.
- Whether a copyleft obligation has actually been triggered by how the code is combined and distributed — needs legal judgement, not a source read.
- Real bundle-size impact of a heavy dependency — needs a build to measure, closed by `runtime.md`'s declared build step when execution is enabled.
- Whether a vendored license notice is legally sufficient — the file existing is checkable; its adequacy is not.
- Whether the update bot's pull requests actually get merged, not just that its config file exists — this module has no probe over commit or PR history.
- Which exact upstream release crossed a relicense boundary — this module can compare the resolved version against a boundary the auditor already knows, but cannot look that boundary up itself.
- Whether a vendored `LICENSE` file's text has been silently altered from what its SPDX identifier implies — the identifier is read, the text integrity is not verified against it.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. This module gains almost nothing from the browser bundle — its whole territory is manifests, lockfiles, and license/notice files, none of which a browser observes. The one narrow exception is a product that renders an in-app "open source licenses" / "third-party notices" page.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `final-state.md` / `read_page` output | An in-app third-party-notices page actually renders non-empty content, corroborating (not replacing) the source-level "Attribution requirements are met" check — only when such a page exists | Info |

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
| Critical dependency resolved on or after a known relicense boundary the shipping model actually triggers | High |
| AGPL/SSPL dependency reachable as a network service the project's own users interact with remotely | Medium |
| Source-available license (BSL/SSPL/RSAL/Elastic License) treated as OSI open source with no field-of-use restriction named | Medium |
