# Dependencies & Licensing

Gate: a lockfile or dependency manifest was detected.

Two questions: is each dependency worth its cost, and are you allowed to ship it?

## Declared vs. used

Both directions, and both matter — this is the `reachability.md` inverse-gap check applied to the manifest.

- [ ] Declared but never imported. Dead weight in the install, and an attack surface for nothing. `search_code` each package name to confirm.
- [ ] **Imported but not declared.** Resolving today only because a transitive dependency hoisted it; the next lockfile update breaks the build or, worse, production. This is `High`.
- [ ] Runtime dependencies sitting in the dev section — fails only for consumers. Cross-reference `packaging.md`.
- [ ] Dev dependencies imported by runtime code.

## Weight

- [ ] Large dependencies used for a fraction of their surface. Name the specific function used and the size of what it drags in.
- [ ] Dependencies that duplicate the standard library or the runtime.
- [ ] Multiple packages solving the same problem — two date libraries, two HTTP clients, two validation libraries. Pick one; the other is a migration nobody finished.
- [ ] Duplicate versions of the same package in the lockfile. Bloat, and a source of "instanceof fails across copies" bugs.

## Health

- [ ] Unmaintained dependencies — last release long past, open issues unanswered, archived repository. Note the migration cost now, before it is forced.
- [ ] Single-maintainer packages on the critical path. Not a defect, but a risk worth naming.
- [ ] Known vulnerabilities. Cite the advisory; do not guess. Cross-reference `security.md`.
- [ ] Postinstall scripts. Each one executes arbitrary code at install time — enumerate them.

## Version discipline

- [ ] Lockfile present and committed. Absent lockfile means no two installs are the same build.
- [ ] Ranges are deliberate. Floating major versions on a runtime dependency accept breaking changes automatically.
- [ ] Pins with a comment explaining a workaround — verify the workaround is still needed. Cross-reference `future.md`.
- [ ] Something updates dependencies on a cadence. No process means the first update will be a forced emergency across many majors at once.

## Licensing

- [ ] Every dependency's license is known, including transitive ones. Unknown is not the same as permissive.
- [ ] No license incompatible with how this project ships. Copyleft in a proprietary distributed product is the classic case — flag it and say what it obligates rather than giving legal advice.
- [ ] The project's own declared license matches the file it ships and the headers in its source.
- [ ] Attribution requirements are met where licenses require notices.
- [ ] Vendored or copy-pasted third-party code retains its original license and attribution. `search_code` for pasted headers.

## Severity guidance

| Situation | Severity |
|---|---|
| Dependency license incompatible with how the project ships | Critical |
| Imported package absent from the manifest | High |
| Known vulnerability in a reachable dependency | High |
| No lockfile committed | High |
| Runtime dependency in the dev section | High |
| Vendored third-party code with attribution stripped | High |
| Unmaintained dependency on the critical path | Medium |
| Unknown license on any dependency | Medium |
| Floating major version on a runtime dependency | Medium |
| Two packages solving the same problem | Low |
| Declared but never imported | Low |
