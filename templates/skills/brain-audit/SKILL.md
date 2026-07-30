---
name: brain-audit
description: "Trigger: audit this project, comprehensive audit, full codebase audit, find dead code, unused features, orphan buttons, broken flows, security/performance/architecture audit. Discovers architecture via project-brain, proposes an audit module set, runs only what the user confirms, and reports findings by severity."
license: Apache-2.0
metadata:
  author: jcsoftdev
  version: "2.0"
  generator: project-brain
---

<!--
  `generator: project-brain` is an ownership marker, not decoration.
  `project-brain setup` overwrites this directory only when it finds that line;
  without it, setup treats the directory as hand-written and leaves it alone.
  Strip it and you pin this copy forever — no upgrade will ever reach it.
-->


## Activation Contract

Apply when asked for a whole-project audit — not a single diff or PR review. Works on any project type: never assume frontend/backend/mobile/CLI before discovery confirms it.

Do not apply when: the ask is scoped to one diff, PR, or file; or the project is not project-brain-indexed (`check_health` fails) — fall back to manual discovery and say so explicitly in the output.

## Hard Rules

- Discovery first, audit second. No module runs before discovery completes.
- **No module runs before the user confirms the module set.** Present the proposal, wait, then load references. Never load all modules by default.
- Route discovery through project-brain, not raw Read/grep sweeps:

| Need | Tool |
|------|------|
| Stack / module overview | `get_architecture` |
| Where to start reading | `repo_map` |
| "How does X work" (no exact name) | `search_context` → `expand_context(chunk_id)` |
| Exact symbol / file / config | `find_symbol` or `search_code` |
| Is this symbol dead? | `find_callers` (empty ⇒ no in-repo caller) |
| What does this depend on? | `find_callees` |
| Blast radius | `impact` |
| Does A reach B? | `trace_path` |
| Results look empty or stale | `check_health`, then `sync_project` |

- `find_callers` returning empty means no **in-repo** caller. Before reporting dead code, rule out: public API surface, dynamic dispatch, reflection, string-keyed registries, framework-convention entry points. State which you ruled out.
- Every finding requires: Title, Category, Severity, Confidence (0-100%), Evidence (`file:line`), Business impact, Technical impact, Recommendation, Priority. Thin evidence ⇒ state the confidence and why. Never invent a finding.
- Severity vocabulary is exactly: Critical | High | Medium | Low | Info.

## Decision Gates

Gates propose; they do not decide. Render each module as `suggested` or `not applicable (reason)`, then ask.

The `Reference` column is the exact filename under `references/` — load that file and nothing else.

| Gate signal | Module | Reference |
|---|---|---|
| Always proposed (no detection needed) | Functional | `functional.md` |
| | Product | `product.md` |
| | Goal | `goal.md` |
| | Future | `future.md` |
| | Reachability | `reachability.md` |
| | Flow Integrity | `flow-integrity.md` |
| | Complexity | `complexity.md` |
| | Consistency | `consistency.md` |
| | Documentation | `documentation.md` |
| | Prompt/Spec Gap | `prompt-spec-gap.md` |
| Server framework or API routes present | Backend | `backend.md` |
| | API | `api.md` |
| UI framework present | Frontend | `frontend.md` |
| | Accessibility | `accessibility.md` |
| Native mobile project | Mobile | `mobile.md` |
| Schema, migrations, or ORM present | Database | `database.md` |
| LLM / AI SDK calls present | AI | `ai.md` |
| Hot path or measurable workload | Performance | `performance.md` |
| Queue, worker, or background jobs | Scalability | `scalability.md` |
| | Concurrency | `concurrency.md` |
| Auth, external input, or network boundary | Failure | `failure.md` |
| | Security | `security.md` |
| | Abuse | `abuse.md` |
| PII or user data persisted | Privacy | `privacy.md` |
| CI/CD, Dockerfile, or IaC present | DevOps | `devops.md` |
| | Infrastructure | `infrastructure.md` |
| Logging / metrics / tracing present **or conspicuously absent** | Observability | `observability.md` |
| Published package manifest or release workflow | Packaging | `packaging.md` |
| | Versioning & Compatibility | `versioning-compatibility.md` |
| Lockfile or dependency manifest present | Dependencies & Licensing | `dependencies-licensing.md` |
| LLM / AI SDK calls, or metered cloud usage | Cost | `cost.md` |
| Test files present **or conspicuously absent** | Testing | `testing.md` |
| Locale files or translation keys present | i18n | `i18n.md` |
| OpenAPI, GraphQL, protobuf, or shared types | Contract Drift | `contract-drift.md` |

The absence gates (`Observability`, `Testing`) fire in both directions on purpose: "this project has no tests at all" is a finding, not a reason to skip the module.

### Establishing each signal

`get_architecture` covers only the manifest-derived signals. Everything else needs a probe, so run these rather than improvising — an improvised gate is a different answer on every run.

| Signal | How to establish it |
|---|---|
| Server framework / API routes | `get_architecture` frameworks; else `search_code` the route-registration call |
| UI framework | `get_architecture` frameworks |
| Native mobile project | `search_code` for `AndroidManifest.xml`, `Info.plist`, `pubspec.yaml`, `*.xcodeproj` |
| Schema / migrations / ORM | `search_code` for a migrations directory, `schema.sql`, or an ORM dependency |
| LLM / AI SDK calls | `search_code` the provider SDK import |
| Metered cloud usage | cloud SDK imports in the dependency manifest |
| Queue / worker / background jobs | `search_code` the queue or scheduler dependency, or a worker entry point |
| Auth, external input, network boundary | any one of: a route table, auth middleware, an outbound HTTP client |
| CI/CD, Dockerfile, IaC | `search_code` for workflow files, `Dockerfile`, `*.tf`, `*.yaml` in a deploy path |
| Logging / metrics / tracing | `search_code` the logger or metrics import — **absence fires the gate too** |
| Test files | `search_code` the test-runner config or `*.test.*` — **absence fires the gate too** |
| Published package manifest / release workflow | manifest from `get_architecture`, plus a release workflow file |
| Lockfile / dependency manifest | `get_architecture` packageManager and manifest |
| PII or user data persisted | schema and model field names — email, phone, address, name, date of birth, government id — plus any free-text column |
| Locale files / translation keys | `search_code` for a locales directory or the translation function |
| OpenAPI / GraphQL / protobuf / shared types | `search_code` for `openapi`, `.graphql`, `.proto`, or a shared-types package |
| Hot path or measurable workload | `repo_map`'s top-ranked symbols, plus any loop over unbounded input |

**A signal you cannot establish is `undetermined`, never `not applicable`.** Say which probe was inconclusive and let the user decide. Reporting an unestablished signal as not-applicable silently drops a module they may have needed, and they have no way to know it happened.

## Execution Steps

1. Discovery — stack, architecture, feature map, via the routing table.
2. Apply gates → proposed module set with per-module rationale.
3. **Present the proposal and wait for confirmation.** Report the token implication of the chosen set.
4. For each confirmed module, read only its `references/<module>.md`, then verify against real code — project-brain first, `Read` only to confirm lines it points at.
5. Collect findings using the schema above.

## Output Contract

In this order: Executive Summary, Project Discovery, Architecture Summary, Feature Map, Modules Run (and why each was skipped), Findings by Severity, Wiring & Reachability Report, Coverage Gaps, Technical Debt, Security Risks, Missing Features, Architectural Risks, Recommendations, Quick Wins, Long-term Improvements.

Never invent issues — every finding is backed by repo evidence.

## References

One file per module under `references/`. Load only confirmed modules.
