# Goal

Does the code still serve the goal it was written for? Codebases drift: the goal moves, the code does not, and nobody writes down the divergence. This module surfaces it.

## Stated goal

- [ ] Locate the goal as written — README opening, package description, ADRs, design docs. `search_code` the project name; `search_context` for "purpose" or "why".
- [ ] If two sources state different goals, that contradiction is a `Medium` finding on its own. Pick neither; report both.
- [ ] If no source states a goal, say so plainly. A project whose purpose exists only in someone's head cannot be onboarded onto.

## Goal vs. architecture

- [ ] The architecture serves the stated goal. A local-first tool with a hard cloud dependency, a "simple" tool with a plugin system, a "fast" tool with a synchronous network call on the hot path — each is a goal/structure mismatch.
- [ ] The highest-PageRank symbols from `repo_map` sit on the goal's critical path. If the center of the call graph is infrastructure rather than the core job, the project may have drifted into building a framework.
- [ ] Constraints implied by the goal are actually enforced. "Offline-capable" ⇒ find the network calls and check each has a degraded path. "Zero-config" ⇒ count required config keys.

## Goal vs. scope

- [ ] Features that serve no stated goal. Not automatically wrong, but each needs a reason — otherwise it is scope that will need maintenance forever.
- [ ] Goals with no supporting feature. The stated ambition nothing implements. This is usually the more expensive direction.
- [ ] Abandoned directions: half-built subsystems, feature flags never turned on, TODOs older than the last major refactor. Cross-check with `Reachability`.

## Decision record

- [ ] Significant architectural choices have a recorded why — ADR, design doc, or at minimum a comment. An unexplained choice cannot be revisited safely because nobody knows what it was trading against.
- [ ] Decisions that were reversed are recorded as reversed, not silently overwritten. Otherwise the next person re-litigates a settled question.
- [ ] Where a decision's rationale has expired (the constraint it optimised for is gone), flag it. That is the highest-value finding in this module.

## Severity guidance

| Situation | Severity |
|---|---|
| Architecture actively prevents a stated goal | High |
| Two sources state contradictory goals | Medium |
| No goal recorded anywhere | Medium |
| Decision whose rationale has expired | Medium |
| Feature serving no stated goal | Low |
| Abandoned direction still in the tree | Low |
