# Packaging

Does what ships match what was built? Gate: a published package manifest or a release workflow was detected.

**This module earns its place empirically.** In this very project, the author's skills were absent from `package.json`'s `"files"` array and shipped to nobody for two months. Every test passed. Nothing detected it, because tests run from the repository where the files exist on disk. That is the exact class of bug this module exists to catch.

## What is in the artefact

- [ ] Enumerate the include list (`files`, `include`, `MANIFEST`, build output config) and compare it to what the code loads at runtime. **Anything read at runtime but absent from the include list ships to nobody.**
- [ ] The inverse: files shipped that need not be — tests, fixtures, source maps in production, `.env` samples with real values, internal docs. Each is bloat, and some are leaks.
- [ ] Entry points declared in the manifest exist in the built artefact at those exact paths.
- [ ] Binaries and executables declared are present and executable.

## Path assumptions

- [ ] No runtime code resolves a path relative to the source tree. Templates, schemas, WASM, and assets read via a source-relative path work in development and fail in the published artefact.
- [ ] Assets needed at runtime are embedded at build time or explicitly shipped and located by a mechanism that survives packaging.
- [ ] Where the project ships a compiled/bundled binary, verify the embedding actually happened rather than trusting it. This is the single highest-value check in the module.

## Install-time verification

- [ ] Something exercises the artefact as a consumer would — installed from a packed tarball, or run from a scratch directory outside the repository with no dependencies present.
- [ ] That check runs in CI. A verification only ever run by hand will stop being run.
- [ ] The check asserts the absence of file-not-found errors, not only a zero exit code — a swallowed load failure exits zero.

## Metadata

- [ ] Version, license, repository, and description are present and accurate.
- [ ] Declared runtime/engine requirements match what the code actually uses.
- [ ] Dependencies are in the right section — nothing needed at runtime sits in dev dependencies. This fails only for consumers, never in the repository.
- [ ] Peer dependencies and optional dependencies are declared deliberately.

## Release process

- [ ] Publishing is automated from a tagged commit, not run from a laptop.
- [ ] The published version corresponds to a commit that exists and is tagged.
- [ ] Nothing can publish from a dirty tree.
- [ ] Multi-platform artefacts are built for every platform claimed as supported, not only the maintainer's.

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
