# Supply Chain

Can the artefact you ship be trusted, and can the build that produced it be reproduced? Gate: a lockfile or dependency manifest is present.

`dependencies-licensing.md` owns *which* dependencies exist — their weight, health, and licences. This module does not repeat that inventory; it owns a different question: how each dependency **arrives**, whether the version that lands on a machine is the version anyone reviewed, and whether the build pipeline itself is a trusted, reproducible thing. A project can have perfectly healthy, permissively-licensed dependencies and still be compromised at the point where they are fetched, installed, or published — that gap is this module's entire scope, and it is no longer a specialist corner: OWASP's Top 10:2025 ranks it **A03:2025 — Software Supply Chain Failures**, a top-three category, widened from 2021's narrower A06 "Vulnerable and Outdated Components" (which only covered *using* a component with a known vulnerability) to the whole chain of how a dependency arrives. That 2021→2025 widening is exactly the line this module draws against `dependencies-licensing.md`.

## Install-time execution

- [ ] `search_code` the project's own manifest for `postinstall`, `preinstall`, and `prepare` scripts, and — for any package with native bindings — a `binding.gyp` file. Lifecycle scripts are not the only install-time execution vector: 2026 npm worm campaigns shipped a weaponised `binding.gyp` that triggers `node-gyp` to run attacker code during `install`, specifically because scanners that only watch the `scripts` field miss it. OWASP Top 10:2025 A03 Software Supply Chain Failures names exactly the lifecycle-script vector — the 2025 Shai-Hulud npm worm "used a post-install script to harvest and exfiltrate sensitive data to public GitHub repositories."
- [ ] Whether the install pipeline disables or audits scripts from dependencies — `search_code` CI config and root config files for `--ignore-scripts` (npm/pnpm), `enable-scripts` (yarn), or `trustedDependencies` (bun). **Falsify before flagging as missing**: some package managers ship this off by default and rely on an allowlist file instead — confirm the allowlist exists rather than assuming no gate at all.
- [ ] If scripts are not disabled, whether any allowlist restricts which packages may run them — `search_code` for `trustedDependencies`, an `.npmrc` scripts setting, or the package manager's equivalent — rather than trusting the entire dependency tree by default.

## Lockfile integrity

- [ ] Lockfile present and committed — `get_architecture` packageManager, then confirm the lockfile itself is tracked (`search_code` or a direct path check), not merely present on disk and gitignored.
- [ ] Manifest ranges the lockfile actually satisfies. Read a sample of `dependencies` entries against their resolved lockfile versions — a range the lockfile does not satisfy means a fresh `install` on CI resolves something nobody tested locally. This is the single most common source of "works on my machine, breaks in CI."
- [ ] In a monorepo, every workspace has its dependencies covered by the root lockfile — `search_code` for a `workspaces` / `packages` field, then confirm no workspace manifest references a dependency absent from the lockfile.
- [ ] Read the lockfile for an integrity hash on every entry (`integrity`, `resolved` + checksum, or the package manager's equivalent). An entry with a version but no hash trusts the registry's word at every future install, not just this one.
- [ ] `search_code` for `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, and `bun.lock` at the repo root and flag more than one hit. Two lockfiles from different tools means whichever one CI happens to read is the one actually enforced, and a developer using the other tool silently resolves a different tree.
- [ ] What "locked" means for this ecosystem, checked rather than assumed. `Cargo.lock`, `package-lock.json`/`pnpm-lock.yaml`/`bun.lock`, and `uv.lock` each pin the full resolved dependency graph with a per-entry hash — `go.sum` does not: it is an append-only checksum ledger for modules already downloaded, not a resolved-graph lock, so read it alongside `go.mod` under `-mod=readonly` rather than treating it as equivalent. A Python project's `requirements.txt` with exact `==` pins looks locked but carries no hash unless generated with `--require-hashes` (e.g. via `pip-compile --generate-hashes`) — `search_code` for the flag before assuming pinned means verified.

## Provenance and pinning

- [ ] A minimum-release-age (cooldown) is configured so a freshly-published version cannot resolve immediately — `search_code` for npm's `min-release-age` (npm CLI docs: "only versions that were available more than the given number of days ago will be installed," disabled/`null` by default), pnpm's `minimumReleaseAge` (pnpm ≥10.16), paired with `trustPolicy: no-downgrade` (pnpm ≥10.21), or Bun's `install.minimumReleaseAge` in `bunfig.toml` (Bun ≥1.3). Most compromised releases are pulled within hours; its absence means every install races the takedown.
- [ ] If the repository claims a SLSA level (README badge, `slsa-github-generator` workflow step, or an in-toto attestation reference found via `search_code`), confirm the CI workflow actually meets that level's stated requirements — provenance generated and distributed (L1), build run on hosted infrastructure with a signed provenance (L2), or build isolation plus secret material withheld from user-defined steps (L3), per the SLSA v1.0 spec — rather than trusting the badge. A project with no SLSA claim at all is not the finding; this only fires against a repository asserting a level the workflow file does not, on its face, meet — name which requirement is missing.
- [ ] Dependency sources beyond the default registry — `search_code` the lockfile for `git+`, `github:`, direct tarball URLs, or `file:`/`link:` local paths. Each is a supply-chain path the registry's own integrity checks do not cover.
- [ ] Any git-sourced dependency pinned to a branch or tag rather than a commit SHA — Read the lockfile's `git+` entries for a `#<sha>` suffix versus a branch or tag name. A branch ref is mutable — the maintainer can push different code to it tomorrow and every future install silently picks it up.
- [ ] CI action versions pinned by a full 40-character commit SHA, not a moving tag — the only form GitHub treats as immutable (`uses: actions/checkout@11bd719… # v4.2.2` vs `@v4`) — `search_code` workflow files for `uses:` lines. GitHub's "allowed actions" policy can enforce SHA-pinning org-wide since August 2025; a repo relying on that setting alone, rather than the pin itself, is still unproven from source.
- [ ] Container base images pinned by digest (`FROM image@sha256:…`) rather than a tag that can be repointed (`:latest`, `:20`) — `search_code` Dockerfiles for `FROM`.

## Release and publish trust

- [ ] SBOM generation as part of the release process — `search_code` release workflows for an SBOM tool invocation (`cyclonedx`/`cdxgen` for CycloneDX (spec 1.7, Oct 2025 — the final release in the 1.x line, backward compatible with 1.4–1.6; 2.0 is expected later in 2026, so a reader re-checking this later should confirm 1.7 is still current), `syft` for SPDX (spec 3.0.1, current since the 3.0 line shipped Apr 2024; a 3.1 release candidate is underway), `npm sbom`, or equivalent) and confirm the output is actually published as a release artefact, not just generated and discarded.
- [ ] Provenance or attestation on published artefacts — `search_code` for `npm publish --provenance`, PyPI Trusted Publishing, a `cosign sign`/`cosign attest` step, or GitHub's `actions/attest-build-provenance` action. All four now produce a DSSE-wrapped in-toto statement verifiable with a single tool (cosign has read npm/GitHub/Homebrew provenance alike since v2.4.0; v3 makes this the default) — confirm the step exists, not that anyone has ever run verification against it. npm docs: provenance is "a verifiable link to the package's source code and build instructions," built on Sigstore, but explicitly "does not guarantee the package has no malicious code."
- [ ] Who can publish the artefact — `search_code` the publish workflow for the trigger condition (tag push, manual approval, protected branch) and whether the publishing token is scoped to this package alone or holds broader org access. `search_code` for a long-lived registry token (`NPM_TOKEN`, a stored `PYPI_API_TOKEN`) versus npm/PyPI Trusted Publishing (OIDC, no standing secret) — a long-lived token is a single credential an attacker who phishes or leaks it can use to publish directly, the exact mechanism behind two confirmed incidents: event-stream (a social-engineered maintainer takeover that added a malicious dependency harvesting Copay bitcoin-wallet credentials) and ua-parser-js (three malicious published versions; GitHub's own advisory calls any host running them "fully compromised," with all secrets and keys on it needing rotation). A stored token scoped to this package alone, with evidence of required 2FA/approval on the publish step, is materially lower-risk than an unscoped, ungated one — this check cannot see the registry-side account state itself.
- [ ] Whether publishing requires a review gate — `search_code` the publish workflow for a required-approval step or a branch-protection prerequisite before the tag that triggers release — rather than firing on any push to a default branch.

## CI/CD pipeline hardening

- [ ] `search_code` workflow files for an untrusted GitHub context value (`${{ github.event.issue.title }}`, `${{ github.event.pull_request.title }}`, a PR body or branch name) interpolated directly into a `run:` shell string, especially combined with `pull_request_target` — this is a script-injection path into the CI runner's secrets and publish credentials, not merely a lint concern. OpenSSF Scorecard's "Dangerous-Workflow" check names exactly this pattern as an automated, named defect class. The untrusted value passed through an intermediate `env:` block rather than inlined directly into the shell string — GitHub's own documented mitigation — is not the finding; check for that indirection before flagging.

## Third-party script trust

- [ ] `search_code` HTML entry points, layout templates, and `<script src=` / `<link rel="stylesheet" href=` occurrences for a cross-origin URL (a CDN host, not the project's own origin) with no `integrity=` attribute; a resource loaded from a third party with no integrity hash is unverified at the browser's own last line of defense against a CDN compromise. W3C Subresource Integrity spec: SRI "defines a mechanism by which user agents may verify that a fetched resource has been delivered without unexpected manipulation," defending against "an attacker who can replace the file on the Content Delivery Network (CDN) server." The framework injecting `integrity` automatically at build time (e.g. a Vite/webpack SRI plugin), rather than it appearing in the source template, is not the finding — check the build config for such a plugin before flagging the source-level absence.
- [ ] `search_code` server/middleware config (Helmet, Next.js `headers()`, a CSP `<meta>` tag) for a `Content-Security-Policy` with a `script-src` directive; report its absence, or a `script-src` that includes `'unsafe-inline'`/`*` alongside third-party hosts found in the manifest or via the SRI check above, as a control that would not stop an unvetted script origin from executing. OWASP A03:2025 prevention guidance: "Only obtain components from official (trusted) sources over secure links." CSP set at the reverse-proxy/CDN edge (Cloudflare, hosting-platform headers config) rather than in application code is not the finding — confirm via deployment documentation before flagging as absent.

## Impersonation and unvetted origin

- [ ] Internal-looking package names resolved from a public registry rather than a private one — Read the manifest for names that look like internal tooling (`@company/*`, `internal-*`) and confirm they resolve from a scoped/private registry, not the public one, where a typosquat could sit under the same unscoped name. Rule out first — an org that has legitimately claimed and publishes under that same scope on the public registry looks identical to a typosquat vector from source alone; confirm via the registry's own ownership/verification page or an org-level `.npmrc` mapping before flagging as unvetted. Duan, Wu, Ji, Rhee, Guo, Bhaskar, Chen & Jiang, "Towards Measuring Supply Chain Attacks on Package Managers for Interpreted Languages," NDSS 2021 — 339 malicious packages found across npm/PyPI/RubyGems, 278 confirmed by the registries, three exceeding 100,000 downloads each.
- [ ] Read the manifest's dependency names and flag any within a one- or two-character edit distance of a well-known, heavily-downloaded package (`lodash`/`lodahs`, `express`/`experss`, `chalk`/`chalks`) that is not itself the declared dependency. A near-miss name is either a legitimate, deliberately-named internal package or a typosquat riding on a fat-fingered `npm install` — the auditor states which before treating it as either. Rule out a known scoped fork, an intentionally similar in-house polyfill with its own README explaining the name, or a package confirmed via the registry's ownership page as the real, verified maintainer.
- [ ] Vendored or copied third-party code with no recorded origin — `search_code` for a directory of third-party-looking code with no corresponding manifest entry, no `LICENSE`, and no comment naming its source or version. This is the one class of risk no dependency tool will ever surface, because it was never declared a dependency at all. `dependencies-licensing.md` owns the licensing angle of the same finding (does the retained code carry its original license and attribution); this module's angle is narrower — nobody can vouch for what the code actually does.

## Out of static reach

- Whether a registry package's published tarball actually matches its public source repository at that version — requires fetching and diffing both, not reading the manifest.
- Runtime behaviour of any postinstall script or `binding.gyp`-triggered native build — this module can enumerate that scripts (or build files) exist, not what they do without executing them — closed by `runtime.md` when execution is enabled: its frozen install (`npm ci`/`pnpm install --frozen-lockfile`) executes any postinstall script and its exit code/output become observable.
- Whether `--ignore-scripts` (or its equivalent) is actually honoured at install time in CI, versus merely configured somewhere and silently overridden.
- Registry-level compromise of a dependency between the version pinned in the lockfile and what a fresh resolve would fetch today.
- Whether the SBOM checked into the release matches the artefact that was actually built and shipped, rather than one generated from a different commit.
- Whether the humans who can publish a dependency protect that access with 2FA — this module can see who this repo trusts to publish its own artefact, not who a third-party maintainer trusts with theirs.
- Whether a dangerous-workflow pattern (untrusted input injected into a shell step) is live-exploitable right now — this module can show the pattern exists in source, not that an attacker has a path to trigger it in this repository's current permission and branch-protection configuration.
- Whether a build platform that requests SLSA L3 genuinely provides its isolation guarantee — that isolation is a property of the CI provider's runtime infrastructure, not of the workflow YAML; the YAML shows what was requested, not what the runner actually enforced.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl`, `console.jsonl`, `read_page` output | A third-party script/style host actually loading has no matching `integrity=` in the served markup, and no CSP `script-src` restricting it (cross-checked against the static SRI/CSP findings above) | High |
| `network.jsonl`, cross-referenced against `search_code` of the manifest/lockfile | A script loading from a public CDN host (`unpkg.com`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`) has no corresponding entry in the manifest or lockfile at all — an undeclared dependency none of this module's lockfile-integrity, min-release-age, or provenance checks ever covered | High |

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
| Untrusted GitHub context value interpolated directly into a `run:` shell step (CI script injection) | High |
| Long-lived, unscoped publish token with no 2FA/approval evidence, instead of Trusted Publishing/OIDC | Medium |
| Third-party script/style tag loaded cross-origin with no `integrity=` attribute | Medium |
| Missing or overly permissive `script-src` CSP directive against third-party origins | Low |
| Repository claims a SLSA level its CI workflow does not, on its face, meet | Medium |
| Dependency name within edit-distance of a well-known package, not itself declared (typosquat candidate) | Medium |
