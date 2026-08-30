# DevOps

Build, test, and release pipeline. Gate: CI/CD, a Dockerfile, or IaC was detected.

Read the pipeline as code, because it is. The same standards apply: no secrets inline, no unpinned inputs, no silent failure.

## Pipeline integrity

- [ ] The pipeline actually fails the build on test failure, type error, and lint error. `search_code` for `continue-on-error`, `|| true`, and `--passWithNoTests` — each one can turn a red build green. Rule-out: a `continue-on-error` on a genuinely advisory step (a nightly benchmark, an experimental linter) is not a defect; read what the step does before flagging it.
- [ ] Every check that matters locally also runs in CI. Read the scripts declared in `package.json`/`Makefile` and the setup steps in README or CONTRIBUTING, then read the CI workflow's actual step list — a script documented or runnable locally but never invoked by a workflow step is decoration, not a check.
- [ ] The pipeline triggers on the branches and events that matter. Read the workflow's `on:` block and confirm the merge-target branch and the PR event are both present — a workflow that only runs on `push` to `main` never gates the PR that lands there.
- [ ] Required checks are enforced by branch protection — **this is a platform setting, not a file in the repository.** (OpenSSF Scorecard's own `Branch-Protection` check hits the same wall and queries the GitHub API for it rather than reading source.) A ruleset file or `CODEOWNERS` checked into the repo is the only in-repo signal, and even that only proves a rule was declared, not that GitHub enforces it as required. State explicitly that enforcement itself is `undetermined` from source and belongs in `Out of static reach`; this module can confirm only that the check exists and runs.

## Reproducibility

- [ ] Lockfile committed and CI installs from it exactly. `search_code` the CI workflow for the install command — `npm ci`, `yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile` are frozen installs; a bare `npm install`/`yarn install` resolves and can silently drift the lockfile on every run.
- [ ] Action, image, and tool versions are pinned. `search_code` workflow files for `uses: <action>@v` — a version tag floats, a 40-character commit SHA does not. Read the Dockerfile's `FROM` line for the same distinction: a tag can be repointed by its publisher, a digest cannot.
- [ ] Build does not depend on ambient state. Read the workflow for steps referencing paths or tools outside the checked-out repository, and for a self-hosted runner whose pre-installed toolchain the workflow never declares — a hosted-runner workflow that suddenly needs a self-hosted label is the tell.
- [ ] The same artefact that was tested is the one that deploys. Read whether the deploy job downloads the build artefact the test job produced (`actions/upload-artifact` / `download-artifact` or equivalent) or invokes its own separate build step — two independent build invocations across jobs means the tested bits and the shipped bits are not provably identical.

## Secrets in CI

- [ ] No secret in pipeline YAML, build args, or image layers. `search_code` for `secret`, `password`, `token`, `api_key` in workflow files and `Dockerfile`/`docker-compose` build-arg blocks. Rule-out: a hit that is `${{ secrets.X }}` or `${{ env.X }}` interpolation is the secrets manager working correctly; the finding is a literal string assigned where one of those references belongs — read each hit before reporting, do not flag the pattern name alone.
- [ ] Secrets are not echoed. `search_code` for `set -x` or `ACTIONS_STEP_DEBUG`/`ACTIONS_RUNNER_DEBUG` in steps that also reference `secrets.` — verbose mode prints the resolved command line, secret included.
- [ ] Pull requests from forks cannot access secrets. Read the workflow trigger: plain `pull_request` never exposes repository secrets to a fork's code, so do not flag it — that is the safe default and a common false alarm. `pull_request_target` combined with checking out the fork's ref (`ref: ${{ github.event.pull_request.head.sha }}`) is the dangerous "pwn request" pattern, because it runs with base-repo secrets against fork-controlled code.
- [ ] Two distinct platform mitigations narrow this, and neither is a substitute for reading the workflow. **Workflow-source pinning** (effective 2025-12-08): `pull_request_target` now always takes its workflow file and ref from the repository's default branch, regardless of the PR's base branch — this closes the older exploit of smuggling a malicious workflow version onto a stale non-default branch and waiting for it to trigger. **`actions/checkout` v7** (shipped 2026-06-18): blocks and fails a workflow that tries to check out unreviewed fork-PR code under `pull_request_target` or `workflow_run` — this is enforcement at the checkout step itself, not a change to which workflow file runs. Read the workflow's checkout step and its `actions/checkout` version against both dates before deciding which mitigation, if either, applies.
- [ ] The `actions/checkout` v7 enforcement was backported to the other supported majors on 2026-07-16 — v4, v5, and v6 all inherit the fork-checkout block automatically because they're floating tags GitHub repoints. **`v1` was not backported and does not block it.** `search_code` workflow files for `uses: actions/checkout@v1` under a `pull_request_target`/`workflow_run` trigger — that combination is now a concrete, readable finding, not an inference. The block also does not reach a workflow pinned to a fixed commit SHA predating the backport, or one that clones the fork's ref by hand instead of via `actions/checkout` — name which case applies before concluding the repo is covered.
- [ ] Third-party actions and images have pinned digests. `search_code` workflow files for `uses:` lines lacking a 40-character SHA — the convention is `uses: owner/action@<sha> # v4.2.2`, SHA resolved, tag kept only as a human-readable comment. A floating tag on a third-party action is a supply-chain dependency that can change underneath the pipeline without review; GitHub can enforce this org-wide via its actions-policy SHA-pinning setting (GA since August 2025), but that setting lives outside the repo and is not confirmable from source.

## Container hygiene

- [ ] Multi-stage build so build tooling is not in the final image. Read the Dockerfile, count `FROM` stages, and confirm the final stage `COPY --from=` only the build output, never the compiler, package manager cache, or dev dependencies.
- [ ] Runs as a non-root user. `search_code` the Dockerfile for a `USER` directive — its absence means the container runs as root by default, and that is the finding, not an assumption to double-check.
- [ ] Base image is minimal, specific, and updatable. Read the `FROM` line: a distroless, Alpine, or `-slim` variant carries a materially smaller attack surface than a full `ubuntu`/`debian` image with the same tooling available to an attacker post-compromise — name which family is in use. A pinned tag or digest is checkable; `latest` or an untagged reference is not, and "something updates it" needs a Renovate/Dependabot config or equivalent — `search_code` for one.
- [ ] Build context excludes what should not ship. Read the `.dockerignore` file's actual contents — its mere existence proves nothing — and confirm `.git`, `node_modules`, `.env`, and test fixtures are each covered, not assumed covered by a wildcard that does not match them.
- [ ] Healthcheck defined, and it reflects readiness rather than only liveness. `search_code` for `HEALTHCHECK`, then read what it curls or invokes — a check that only confirms the process is running (e.g. hitting `/` with no dependency check) reports healthy while the database connection is down.
- [ ] Capabilities are dropped and the root filesystem is read-only wherever the application allows it. `search_code` the Dockerfile, compose file, or Kubernetes manifest for `cap_drop: [ALL]` / `--cap-drop=ALL` and `readOnlyRootFilesystem: true` / `read_only: true`. Their absence means the container keeps the full default Linux capability set and a writable root even after the non-root and multi-stage fixes above — a step past "not root," and the next thing 2026 hardening baselines check for.

## Deploy and rollback

- [ ] A documented rollback path exists. `search_code` docs and runbooks for "rollback" and read the steps. This module can confirm only that a documented path exists, not that it has ever been exercised — whether it actually works under a real failure is `undetermined` from source and belongs in `Out of static reach`.
- [ ] Migrations and code deploys are ordered so a running old version does not break. Cross-reference the destructive-migration check in `database.md`: read migration files for additive-vs-destructive shape (a dropped or renamed column breaks the old version still running against it) and compare against the deploy workflow's ordering of migrate-then-deploy vs deploy-then-migrate.
- [ ] Deploys are atomic or gradual, not partial-and-visible. Read the deployment platform's config — a Kubernetes rolling-update strategy, a blue-green or canary configuration — for the actual cutover mechanism rather than assuming one.
- [ ] Configuration differs from code, so a config change does not require a rebuild. `search_code` for values that should be environment-driven but are hardcoded into source, and cross-reference the declared environment-variable list in `infrastructure.md`.

## Local parity

- [ ] A new contributor can build and test with documented steps that work. Read the setup steps in README or CONTRIBUTING and cross-check each command literally exists in `package.json`/`Makefile` — a documented command that has silently drifted from the actual script name is the finding, and following the steps as written is the probe, not a formality.
- [ ] Local and CI use the same tool versions. `search_code` for `.nvmrc`, `.tool-versions`, or an `engines` field, then compare the version it names against the version pinned in the CI workflow — a mismatch means "works on my machine" is provably possible.
- [ ] Nothing required for development is available only to existing team members. `search_code` setup docs for internal URLs or private registries and check whether an access-request process is documented alongside them; an undocumented internal dependency blocks every new contributor identically.

## Out of static reach

- Whether required checks are actually enforced by branch protection — a platform setting invisible to source, not a file.
- Whether a documented rollback procedure has ever been executed successfully.
- True build reproducibility across machines and over time, beyond what pinned versions and lockfiles imply.
- Whether CI secrets are scoped correctly at the provider (environment restrictions, least-privilege service accounts) rather than merely referenced correctly in YAML.
- Real autoscaling and deploy-strategy behaviour under production load.
- Whether the pipeline's actual delivery performance meets any DORA benchmark — DORA's 2025 report reframed the classic four metrics into five (deployment frequency, lead time for changes, failed-deployment recovery time, change fail rate, deployment rework rate). This module can confirm a pipeline exists and how it's gated, not how often it fires or how long a change takes once merged — that needs CI run history and incident data outside source.

## Severity guidance

| Situation | Severity |
|---|---|
| Secret in pipeline config, build arg, or image layer | Critical |
| `pull_request_target` checks out and runs fork-PR head, with no checkout-level block in effect (`actions/checkout@v1`, a pre-2026-07-16 pinned SHA, or a hand-rolled clone) | Critical |
| Pipeline cannot fail the build (`\|\| true`, `continue-on-error`) | High |
| Artefact rebuilt between test and deploy | High |
| Container runs as root | High |
| Untested or absent rollback path | High |
| Unpinned action, image, or tool version | Medium |
| Build depends on ambient developer state | Medium |
| Build context ships `.git` or secrets | Medium |
| Documented local setup that does not work | Medium |
| No capability drop or read-only root filesystem configured | Medium |
