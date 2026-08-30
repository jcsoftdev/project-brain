# Goal

Does the code still serve the goal it was written for? Codebases drift: the goal moves, the code does not, and nobody writes down the divergence. This module surfaces it.

## Stated goal

- [ ] Locate the goal as written — README opening, package description, ADRs, design docs. `search_code` the project name; `search_context` for "purpose" or "why".
- [ ] If two sources state different goals, `search_code` each source's exact goal phrase to confirm both are current — rule out one being superseded by a changelog, deprecation note, or newer doc before calling it a live contradiction. A genuine contradiction is a `Medium` finding on its own. Pick neither; report both.
- [ ] If no source states a goal, `search_code` "purpose", "goal", "mission" across the repo root and docs directory to confirm the absence rather than assume it. A project whose purpose exists only in someone's head cannot be onboarded onto.

## Goal vs. architecture

- [ ] The architecture serves the stated goal. `get_architecture` for the dependency list: a local-first tool with a hard cloud SDK dependency, a "simple" tool with a plugin system, a "fast" tool with a synchronous network call on the hot path — `find_callers` the hot-path function to confirm it is actually on a called-often path before flagging it. Each confirmed mismatch is a goal/structure defect.
- [ ] The highest-PageRank symbols from `repo_map` sit on the goal's critical path. If the centre of the call graph is infrastructure rather than the core job, the project may have drifted into building a framework.
- [ ] Constraints implied by the goal are actually enforced. "Offline-capable" ⇒ `search_code` the network-client import and check each call site has a degraded/cached path. "Zero-config" ⇒ `search_code` required config reads and count the keys with no default.

## Goal vs. scope

- [ ] Features that serve no stated goal. `find_callers` each major feature's entry point and check whether its purpose traces back to the stated goal. Not automatically wrong — but each needs a reason, or it is scope that will need maintenance forever.
- [ ] Goals with no supporting feature. Read the stated goal's claims one by one and `search_code` each for a corresponding entry point. The stated ambition nothing implements is usually the more expensive direction.
- [ ] Abandoned directions: half-built subsystems, feature flags never turned on, TODOs older than the last major refactor. `search_code` for `TODO`/`FIXME` and, where `Repo History` is in the confirmed module set, cross-check the comment's age against recent activity in that file. Cross-check flags with `Reachability`.

## Decision record

- [ ] Significant architectural choices have a recorded why — ADR, design doc, or at minimum a comment. `search_code` the decision's keyword (the technology or pattern name) across `docs/adr`, `docs/`, and the comments near its `find_symbol` location. An unexplained choice cannot be revisited safely because nobody knows what it was trading against.
- [ ] Decisions that were reversed are recorded as reversed, not silently overwritten. `search_code` for an ADR or doc marked superseded; a reversal with no trace at all means the next person re-litigates a settled question.
- [ ] Where a decision's rationale has expired (the constraint it optimised for is gone), flag it. Read the ADR/comment's stated constraint and check via `find_symbol`/`find_callers` whether the code that constraint drove is still present unchanged. That is the highest-value finding in this module.

## Out of static reach

- Whether the goal as stated is the *right* goal — that is a product judgement, not a static one.
- Whether an architectural mismatch actually causes pain in practice, versus being theoretically inconsistent.
- Team intent behind an undocumented decision, when no comment, ADR, or commit message records it.
- Whether a decision's original constraint has genuinely expired, when nothing in the repo dates the constraint itself.

## Severity guidance

| Situation | Severity |
|---|---|
| Architecture actively prevents a stated goal | High |
| Two sources state contradictory goals, both confirmed current | Medium |
| No goal recorded anywhere | Medium |
| Decision whose rationale has expired | Medium |
| Feature serving no stated goal | Low |
| Abandoned direction still in the tree | Low |
