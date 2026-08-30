# Packaging

Does what ships match what was built? Gate: a published package manifest or a release workflow was detected.

**This module earns its place empirically.** In this very project, the author's skills were absent from `package.json`'s `"files"` array and shipped to nobody for two months. Every test passed. Nothing detected it, because tests run from the repository where the files exist on disk. That is the exact class of bug this module exists to catch — and unlike most modules in this skill, everything it checks is a manifest, a config file, or a build script, all readable in full.

## What is in the artefact

- [ ] Enumerate the include list (`files` in `package.json`, `include`/`MANIFEST.in`, build output config) and compare it against what the code loads at runtime. `search_code` for `readFile`/`require(`/`import(` targeting a relative path, then confirm each target sits inside the include list. **Anything read at runtime but absent from the include list ships to nobody.**
- [ ] The inverse: files shipped that need not be — tests, fixtures, source maps in production, `.env` samples with real values, internal docs. Read the include list and `search_code` for `*.test.*`, `fixtures/`, `.map`, `.env.example` patterns it matches — each hit is bloat, and a `.env` sample with a real-looking value is a leak.
- [ ] Entry points declared in the manifest (`main`, `module`, `exports`, `bin`) exist in the built artefact at those exact paths. Read the manifest's entry fields, then confirm the build output config (`tsconfig`'s `outDir`, the bundler config) actually writes a file to each declared path.
- [ ] Binaries and executables declared are present and executable. Read the manifest's `bin` field, then confirm the target file exists and the build step does not skip generating it.

## Path assumptions

- [ ] No runtime code resolves a path relative to the source tree. `search_code` for `__dirname`, `import.meta.url`, or a relative `../` path adjacent to a `readFile`/asset-load call, then confirm the target stays inside the include list above rather than reaching into `src/` structure that packaging flattens or excludes.
- [ ] Assets needed at runtime are embedded at build time or explicitly shipped and located by a mechanism that survives packaging. `search_code` for a template/schema/WASM file loaded at runtime, then confirm the build config copies or embeds it — absence from both the include list and an embed step means it is missing the moment the source tree is gone.
- [ ] Where the project ships a compiled/bundled binary, verify the embedding actually happened rather than trusting it. Read the build script/bundler config for the embed step, then confirm the built output actually contains the asset — its declared size, or a reference to it in the bundle — rather than trusting the config exists. **This is the single highest-value check in the module.**

## Install-time verification

- [ ] Something exercises the artefact as a consumer would — installed from a packed tarball, or run from a scratch directory outside the repository with no dependencies present. `search_code` the CI workflow files and manifest scripts for a step that packs (`npm pack`, `pip build`) and installs into a scratch directory before running the entry point from there.
- [ ] That check runs in CI. Read the CI workflow file found above and confirm the pack-and-run step is a job triggered on push/PR, not only a local script nobody invokes. A verification only ever run by hand will stop being run.
- [ ] The check asserts the absence of file-not-found errors, not only a zero exit code. Read the CI step's assertion logic — a swallowed load failure inside a try/catch that still exits zero passes a check that proves nothing.

## Metadata

- [ ] Version, license, repository, and description are present and accurate. Read the manifest's `version`, `license`, `repository`, `description` fields and confirm the license field matches the actual `LICENSE` file in the repository root.
- [ ] Declared runtime/engine requirements match what the code actually uses. Read the manifest's `engines`/`requires-python` field, then `search_code` for a language feature (optional chaining, a specific stdlib call) whose minimum version exceeds the declared floor.
- [ ] Dependencies are in the right section — nothing needed at runtime sits in dev dependencies. Read `dependencies` vs `devDependencies` in the manifest, then `search_code` each `devDependencies` entry's import inside runtime (non-test, non-build-script) source files. A hit there fails only for consumers, never in the repository, which is exactly why CI misses it.
- [ ] Peer dependencies and optional dependencies are declared deliberately. Read the manifest's `peerDependencies`/`optionalDependencies`, then `search_code` confirming each is imported conditionally rather than assumed always-present.

## Release process

- [ ] Publishing is automated from a tagged commit, not run from a laptop. `search_code` the CI workflow for a `publish`/`release` job triggered on a tag push, and confirm no local publish script exists that a developer would run with real credentials. This is also the precondition for `npm publish --provenance` or GitHub Attestations to mean anything — cross-reference `supply-chain.md`'s provenance check; a provenance step run from a laptop just moves trust from the registry to the laptop.
- [ ] The published version corresponds to a commit that exists and is tagged. Read the release workflow for a step that tags the commit before or as part of publish, rather than publishing from an arbitrary branch head.
- [ ] Nothing can publish from a dirty tree. Read the release workflow/publish script for a `git status --porcelain`/clean-tree check gating the publish step.
- [ ] Multi-platform artefacts are built for every platform claimed as supported, not only the maintainer's. Read the manifest's `os`/`cpu`/platform-support fields, then confirm the release workflow's build matrix covers each one.

## Out of static reach

- Whether the packed tarball actually installs cleanly on every supported platform and language/runtime version — this module confirms CI runs the check, not that it passes on hardware nobody tested.
- Real download/install size as experienced by a consumer, versus the include list's apparent scope.
- Registry-side behaviour (npm, PyPI) — deprecation warnings, dist-tag correctness, unpublish windows.
- Whether a credential used for publishing is scoped correctly — that lives in the registry/CI secret store, not in source.
- Actual first-run behaviour of the installed artefact on a machine with none of the developer's global tooling present.

## Severity guidance

| Situation | Severity |
|---|---|
| Runtime-loaded file absent from the include list | Critical |
| Runtime path resolved relative to the source tree | Critical |
| Runtime dependency declared as a dev dependency | High |
| Secret or real credential shipped in the artefact | High |
| No verification of the artefact as a consumer would use it | High |
| Declared entry point missing from the artefact | High |
| Verification exists but does not run in CI | Medium |
| Tests and fixtures shipped to consumers | Low |
| Inaccurate engine or license metadata | Low |
