# DevOps

Build, test, and release pipeline. Gate: CI/CD, a Dockerfile, or IaC was detected.

Read the pipeline as code, because it is. The same standards apply: no secrets inline, no unpinned inputs, no silent failure.

## Pipeline integrity

- [ ] The pipeline actually fails the build on test failure, type error, and lint error. `search_code` for `continue-on-error`, `|| true`, and `--passWithNoTests` — each one can turn a red build green.
- [ ] Every check that matters locally also runs in CI. A test suite the pipeline does not run is decoration.
- [ ] The pipeline runs on the branches and events that matter, including the merge target.
- [ ] Required checks are actually required by branch protection, not merely present.

## Reproducibility

- [ ] Lockfile committed and CI installs from it exactly — a frozen/CI install, not a resolving one.
- [ ] Action, image, and tool versions are pinned. A floating tag means yesterday's green build is not reproducible.
- [ ] Build does not depend on ambient state — developer machine paths, pre-installed global tools, network resources that can change.
- [ ] The same artefact that was tested is the one that deploys. Rebuilding between test and deploy tests one thing and ships another.

## Secrets in CI

- [ ] No secret in pipeline YAML, build args, or image layers. Build args are visible in image history.
- [ ] Secrets are not echoed. `search_code` for debug flags in the pipeline (`set -x`, verbose modes) alongside secret usage.
- [ ] Pull requests from forks cannot access secrets.
- [ ] Third-party actions and images have pinned digests, or the supply-chain exposure is accepted deliberately.

## Container hygiene

- [ ] Multi-stage build so build tooling is not in the final image.
- [ ] Runs as a non-root user.
- [ ] Base image is specific and updatable, and something updates it.
- [ ] Build context excludes what should not ship — `.git`, `node_modules`, `.env`, test fixtures. Check the ignore file exists and covers them.
- [ ] Healthcheck defined, and it reflects readiness rather than only liveness.

## Deploy and rollback

- [ ] There is a documented, tested rollback. An untested rollback is a hope.
- [ ] Migrations and code deploys are ordered so a running old version does not break — cross-reference the destructive-migration check in `database.md`.
- [ ] Deploys are atomic or gradual, not partial-and-visible.
- [ ] Configuration differs from code, so a config change does not require a rebuild.

## Local parity

- [ ] A new contributor can build and test with documented steps that work. Follow them literally and report each divergence.
- [ ] Local and CI use the same tool versions.
- [ ] Nothing required for development is available only to existing team members.

## Severity guidance

| Situation | Severity |
|---|---|
| Secret in pipeline config, build arg, or image layer | Critical |
| Pipeline cannot fail the build (`\|\| true`, `continue-on-error`) | High |
| Artefact rebuilt between test and deploy | High |
| Container runs as root | High |
| Untested or absent rollback path | High |
| Unpinned action, image, or tool version | Medium |
| Build depends on ambient developer state | Medium |
| Build context ships `.git` or secrets | Medium |
| Documented local setup that does not work | Medium |
