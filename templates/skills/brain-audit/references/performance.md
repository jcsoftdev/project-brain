# Performance

Where does time and memory actually go? Gate: a hot path or a measurable workload was detected. This module was defined in the original audit design but no gate ever enabled it — it could never run. It runs now.

**Measure or say you did not.** A performance finding with no number is a guess. If you cannot measure, state the complexity and the input size at which it matters, and mark the confidence accordingly.

## Find the hot paths first

- [ ] `repo_map` ranks symbols by PageRank over the call graph — the top of that list is where a slowdown costs the most.
- [ ] For each candidate, `find_callers` to learn how often it is reached, and `find_callees` to see what it drags in.
- [ ] Anything called inside a loop, per request, or per item is a hot path regardless of how cheap it looks alone.

## Algorithmic cost

- [ ] Nested iteration over the same collection — O(n²) that is fine at 10 and fatal at 10,000. State the crossover.
- [ ] Repeated linear scans where a map or set would be constant. `find_callees` for `includes`/`indexOf`/`find` inside a loop.
- [ ] Sorting or grouping recomputed on every access instead of once.
- [ ] Work repeated per item that could be hoisted out of the loop — regex compilation, config lookup, date parsing.

## I/O

- [ ] Sequential awaits over independent operations. These should be concurrent; each one serialised costs its full latency.
- [ ] A query, file read, or network call inside a loop. Cross-reference `Database`'s N+1 check.
- [ ] Whole files or whole tables loaded to use part of them.
- [ ] Missing pagination, streaming, or batching wherever the input can grow.
- [ ] Synchronous filesystem or crypto calls on a request path.

## Memory

- [ ] Unbounded accumulation: a cache with no eviction, an array that only grows, a map keyed by user input.
- [ ] Whole-result materialisation where a stream or iterator would do.
- [ ] Retained references that outlive their use — closures capturing large objects, listeners never removed.
- [ ] Large allocations in a loop that the allocator will churn on.

## Caching

- [ ] Every cache has a stated key, a stated lifetime, and an invalidation path. A cache with no invalidation is a correctness bug wearing a performance costume.
- [ ] Cache keys include everything the value depends on. A key missing a dimension serves the wrong answer.
- [ ] Cached values that are cheap to compute — the cache costs more in complexity than it saves.
- [ ] Nothing caches a mutable object by reference and lets a caller mutate it.

## Startup

- [ ] Nothing expensive happens at import time. Top-level work runs even when the code path is never used.
- [ ] Heavy dependencies are imported lazily at the point of need. Check for a dynamic import where a static one sits on a cold path.

## Severity guidance

| Situation | Severity |
|---|---|
| Unbounded memory growth reachable from user input | High |
| Missing pagination on an endpoint over a growing table | High |
| Cache with no invalidation serving stale correctness-sensitive data | High |
| Sequential awaits over independent I/O on a hot path | Medium |
| O(n²) reachable at realistic input sizes | Medium |
| Synchronous I/O on a request path | Medium |
| Expensive work at import time | Medium |
| Repeated work hoistable out of a loop | Low |
