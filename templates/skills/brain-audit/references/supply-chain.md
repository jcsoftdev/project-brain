# Supply Chain

Can the artefact you ship be trusted, and can the build that produced it be reproduced? Gate: a lockfile or dependency manifest is present.

`dependencies-licensing.md` owns *which* dependencies exist — their weight, health, and licences. This module does not repeat that inventory; it owns a different question: how each dependency **arrives**, whether the version that lands on a machine is the version anyone reviewed, and whether the build pipeline itself is a trusted, reproducible thing. A project can have perfectly healthy, permissively-licensed dependencies and still be compromised at the point where they are fetched, installed, or published — that gap is this module's entire scope, and it is no longer a specialist corner: OWASP's Top 10:2025 ranks it **A03:2025 — Software Supply Chain Failures**, a top-three category, widened from 2021's narrower A06 "Vulnerable and Outdated Components" (which only covered *using* a component with a known vulnerability) to the whole chain of how a dependency arrives. That 2021→2025 widening is exactly the line this module draws against `dependencies-licensing.md`.

## Install-time execution

- [ ] `search_code` the project's own manifest for `postinstall`, `preinstall`, and `prepare` scripts, and — for any package with native bindings — a `binding.gyp` file. Lifecycle scripts are not the only install-time execution vector: 2026 npm worm campaigns shipped a weaponised `binding.gyp` that triggers `node-gyp` to run attacker code during `install`, specifically because scanners that only watch the `scripts` field miss it.
- [ ] Whether the install pipeline disables or audits scripts from dependencies — `search_code` CI config and root config files for `--ignore-scripts` (npm/pnpm), `enable-scripts` (yarn), or `trustedDependencies` (bun). **Falsify before flagging as missing**: some package managers ship this off by default and rely on an allowlist file instead — confirm the allowlist exists rather than assuming no gate at all.
- [ ] If scripts are not disabled, whether any allowlist restricts which packages may run them — `search_code` for `trustedDependencies`, an `.npmrc` scripts setting, or the package manager's equivalent — rather than trusting the entire dependency tree by default.

## Lockfile integrity

- [ ] Lockfile present and committed — `get_architecture` packageManager, then confirm the lockfile file itself is tracked (`search_code` or a direct path check), not merely present on disk and gitignored.
- [ ] Manifest ranges the lockfile actually satisfies. Read a sample of `dependencies` entries against their resolved lockfile versions — a range the lockfile does not satisfy means a fresh `install` on CI resolves something nobody tested locally. This is the single most common source of "works on my machine, breaks in CI."
- [ ] In a monorepo, every workspace has its dependencies covered by the root lockfile — `search_code` for a `workspaces` / `packages` field, then confirm no workspace manifest references a dependency absent from the lockfile.
- [ ] Integrity hashes present for every lockfile entry (`integrity`, `resolved` + checksum, or the package manager's equivalent). An entry with a version but no hash trusts the registry's word at every future install, not just this one.
- [ ] Only one package manager's lockfile is present. Two lockfiles from different tools (`package-lock.json` alongside `pnpm-lock.yaml`) means whichever one CI happens to read is the one actually enforced, and a developer using the other tool silently resolves a different tree.
- [ ] What "locked" means for this ecosystem, checked rather than assumed. `Cargo.lock`, `package-lock.json`/`pnpm-lock.yaml`/`bun.lock`, and `uv.lock` each pin the full resolved dependency graph with a per-entry hash — `go.sum` does not: it is an append-only checksum ledger for modules already downloaded, not a resolved-graph lock, so read it alongside `go.mod` under `-mod=readonly` rather than treating it as equivalent. A Python project's `requirements.txt` with exact `==` pins looks locked but carries no hash unless generated with `--require-hashes` (e.g. via `pip-compile --generate-hashes`) — `search_code` for the flag before assuming pinned means verified.

## Provenance and pinning

- [ ] A minimum-release-age (cooldown) is configured so a freshly-published version cannot resolve immediately — `search_code` for npm's `min-release-age`, pnpm's `minimumReleaseAge` (paired with `trustPolicy: no-downgrade`, pnpm ≥10.21), or Bun's `install.minimumReleaseAge` in `bunfig.toml` (Bun ≥1.3). Most compromised releases are pulled within hours; its absence means every install races the takedown.
- [ ] Dependency sources beyond the default registry — `search_code` the lockfile for `git+`, `github:`, direct tarball URLs, or `file:`/`link:` local paths. Each is a supply-chain path the registry's own integrity checks do not cover.
- [ ] Any git-sourced dependency pinned to a branch or tag rather than a commit SHA — read the lockfile's `git+` entries for a `#<sha>` suffix versus a branch or tag name. A branch ref is mutable — the maintainer can push different code to it tomorrow and every future install silently picks it up.
- [ ] CI action versions pinned by a full 40-character commit SHA, not a moving tag — the only form GitHub treats as immutable (`uses: actions/checkout@11bd719… # v4.2.2` vs `@v4`) — `search_code` workflow files for `uses:` lines. GitHub's actions-policy can enforce this org-wide (SHA-pinning policy, GA since August 2025); a repo relying on that alone, rather than the pin itself, is still unproven from source.
- [ ] Container base images pinned by digest (`FROM image@sha256:…`) rather than a tag that can be repointed (`:latest`, `:20`) — `search_code` Dockerfiles for `FROM`.

## Release and publish trust

- [ ] SBOM generation as part of the release process — `search_code` release workflows for an SBOM tool invocation (`cyclonedx`/`cdxgen` for CycloneDX (spec 1.7, Mar 2026 — the final release in the 1.x line, backward compatible with 1.4–1.6; 2.0 is expected later in 2026, so a reader re-checking this later should confirm 1.7 is still current), `syft` for SPDX (spec 3.0.1, current since the 3.0 line shipped Apr 2024; a 3.1 release candidate is underway), `npm sbom`, or equivalent) and confirm the output is actually published as a release artefact, not just generated and discarded.
- [ ] Provenance or attestation on published artefacts — `search_code` for `npm publish --provenance`, PyPI Trusted Publishing, a `cosign sign`/`cosign attest` step, or GitHub's `actions/attest-build-provenance` action. All four now produce a DSSE-wrapped in-toto statement verifiable with a single tool (cosign v3 reads npm provenance, GitHub Attestations, and Homebrew provenance alike) — confirm the step exists, not that anyone has ever run verification against it.
- [ ] Who can publish the artefact — `search_code` the publish workflow for the trigger condition (tag push, manual approval, protected branch) and whether the publishing token is scoped to this package alone or holds broader org access.
- [ ] Whether publishing requires a review gate — `search_code` the publish workflow for a required-approval step or a branch-protection prerequisite before the tag that triggers release — rather than firing on any push to a default branch.

## Impersonation and unvetted origin

- [ ] Internal-looking package names resolved from a public registry rather than a private one — read the manifest for names that look like internal tooling (`@company/*`, `internal-*`) and confirm they resolve from a scoped/private registry, not the public one, where a typosquat could sit under the same unscoped name.
- [ ] Vendored or copied third-party code with no recorded origin — `search_code` for a directory of third-party-looking code with no corresponding manifest entry, no `LICENSE`, and no comment naming its source or version. This is the one class of risk no dependency tool will ever surface, because it was never declared a dependency at all.

## Out of static reach

- Whether a registry package's published tarball actually matches its public source repository at that version — requires fetching and diffing both, not reading the manifest.
- Runtime behaviour of any postinstall script or `binding.gyp`-triggered native build — this module can enumerate that scripts (or build files) exist, not what they do without executing them.
- Whether `--ignore-scripts` (or its equivalent) is actually honoured at install time in CI, versus merely configured somewhere and silently overridden.
- Registry-level compromise of a dependency between the version pinned in the lockfile and what a fresh resolve would fetch today.
- Whether the SBOM checked into the release matches the artefact that was actually built and shipped, rather than one generated from a different commit.

## Severity guidance

| Situation | Severity |
|---|---|
| Git dependency pinned to a mutable branch, not a commit | High |
| Postinstall scripts enabled with no allowlist across the full dependency tree | High |
| Lockfile absent, uncommitted, or not satisfying the manifest range | High |
| Publish token unscoped or publish requires no review gate | High |
| Internal-looking package name resolving from the public registry | High |
| CI action or base image pinned by moving tag, not digest/SHA | Medium |
| No SBOM or provenance attestation in the release process | Medium |
| Vendored code with no recorded origin or version | Medium |
| Lockfile entry missing an integrity hash | Medium |
| Monorepo workspace not covered by the root lockfile | Medium |
| No minimum-release-age / cooldown configured on the package manager | Medium |
