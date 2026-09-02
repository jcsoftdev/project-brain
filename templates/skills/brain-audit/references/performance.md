# Performance

Where does time and memory actually go? Gate: a hot path or a measurable workload was detected. This module was defined in the original audit design but no gate ever enabled it — it could never run. It runs now.

A performance finding with no measurement behind it is `inferred` — a hypothesis about the shape of the code, not a measured fact — and per the Evidence Contract that caps it at `Medium`, no matter how bad it would be if true. It reaches `High` only when paired with `read` evidence that pins the input size, call frequency, or a config value proving no bound exists. It cannot reach `Critical` in this module: the auditor has no profiler, benchmark, or load test to run, so nothing here is ever `executed`.

## Find the hot paths first

- [ ] `repo_map` ranks symbols by PageRank over the call graph — the top of that list is where a slowdown costs the most.
- [ ] For each candidate, `find_callers` to learn how often it is reached, and `find_callees` to see what it drags in.
- [ ] Anything called inside a loop, per request, or per item is a hot path regardless of how cheap it looks alone — confirm the call site with `search_code` for the enclosing `for`/`while`/`.map`/`.forEach`.
- [ ] An unbounded loop or an O(n²) block earns no severity above `Low` on its own. It matters only on a path that is actually hot: anchor the claim to a `repo_map` rank and a `find_callers` count, not to how alarming the code reads.

## Algorithmic cost

- [ ] Nested iteration over the same collection: `search_code` for a loop whose body contains a second loop over a variable bound in the outer one. O(n²) is fine at 10 and fatal at 10,000 — state the crossover, and rule out that the outer collection is bounded by construction (a fixed enum, a fixed page size) before flagging it.
- [ ] Repeated linear scans where a map or set would be constant: `find_callees` for `includes`/`indexOf`/`find` called inside a loop.
- [ ] Sorting or grouping recomputed on every access instead of once: `find_callers` on the sort/group function — a call count that tracks request volume, with nothing caching the result in between, is the finding.
- [ ] Work repeated per item that could be hoisted out of the loop: `search_code` for `new RegExp(`, a config-lookup call, or `new Date(`/`Date.parse(` sitting inside a loop body — each is cheap once and wasteful per item.

## I/O

- [ ] Sequential awaits over independent operations: `Read` the function body for consecutive `await` calls not wrapped in `Promise.all`/`allSettled`. Rule out a genuine data dependency — the second call needs the first's result — before flagging; if it does, this is correct code, not a defect.
- [ ] A query, file read, or network call inside a loop: `find_callees` on the loop body for a query/fetch/`readFile` call. Cross-reference `Database`'s N+1 check.
- [ ] Whole files or whole tables loaded to use part of them: `search_code` for `SELECT *` with no `LIMIT`/`WHERE` narrowing the row count, or a full-file read immediately followed by an in-memory filter.
- [ ] Missing pagination, streaming, or batching wherever the input can grow: `search_code` a route handler's query call for the absence of `LIMIT`/`OFFSET`/a cursor parameter.
- [ ] Synchronous filesystem or crypto calls on a request path: `search_code` for `readFileSync`, `writeFileSync`, `execSync`, `*Sync(` inside a handler, then `find_callers` to confirm the handler is reached from a route rather than a CLI or build script — the same call is a non-issue in a one-shot script.

## Memory

- [ ] Unbounded accumulation: `search_code` for a module-level `Map`/`Set`/array populated via `.push`/`.set` with no matching eviction, `maxSize`, or TTL nearby. Rule out that the key space is bounded by construction — a fixed set of feature flags is not user input.
- [ ] Whole-result materialisation where a stream or iterator would do: `search_code` for `.toArray()`/`.fetchAll()`/`readFileSync` used against a source with no declared size cap.
- [ ] Retained references that outlive their use: `search_code` for `addEventListener`/subscription calls with no paired `removeEventListener`/`unsubscribe`; `find_callers` on the owning object to check whether it is ever torn down.
- [ ] Large allocations in a loop that the allocator will churn on: `search_code` for `new Array(`, `Buffer.alloc(`, or an object/array literal constructed inside a loop body.

## Caching

- [ ] Every cache has a stated key, a stated lifetime, and an invalidation path: `search_code` the cache import (`lru-cache`, `node-cache`, a hand-rolled `Map`), then read the set/get sites for a TTL and an explicit invalidation call. A cache with no invalidation is a correctness bug wearing a performance costume. Rule out a content-addressed key (a hash of the cached value or an immutable source) — invalidation is meaningless when the key already changes whenever the value would.
- [ ] Cache keys include everything the value depends on: `find_symbol` the cached function's signature, then read the key expression — a parameter missing from the key means two distinct inputs collide on one cache entry and one of them gets served the wrong answer.
- [ ] Cached values that are cheap to compute: `Read` the wrapped function — a single arithmetic expression or constant lookup means the cache costs more in complexity than it saves.
- [ ] Nothing caches a mutable object by reference and lets a caller mutate it: `find_callers` on the cache getter, then check whether any caller mutates the returned object in place.

## Startup

- [ ] Nothing expensive happens at import time: `search_code` for a function call or `new Client(`/`.connect(` sitting at module scope rather than inside an exported function. `find_callers` on the module to rule out that it is only ever imported by the entry point itself, where the cost is paid once regardless of what runs.
- [ ] Heavy dependencies are imported lazily at the point of need: `search_code` a known heavy import (image processing, PDF, a large SDK) at the top of a file, then `find_callers` on that file's export to confirm the code path is rarely reached. A static top-level import on a cold path is the finding; a dynamic `import()` at the call site is the fix already in place.

## Frontend rendering (Core Web Vitals)

Applies only when the project serves HTML to a browser — cross-reference the `Web Metadata` gate. Skip this section entirely, and say so, for a pure API/backend/CLI project. The current Core Web Vitals (Google, stable since March 2024) are LCP, INP, and CLS, each scored at the 75th percentile of real-user field data: LCP good ≤2.5s/poor >4.0s, INP good ≤200ms/poor >500ms, CLS good ≤0.1/poor >0.25. None of these are measurable statically — every check below is code shape, not a score. With `browser.md` enabled, `vitals.md` supplies a lab score per flow; see What browser observation closes.

- [ ] The LCP candidate is not blocked behind avoidable work: `search_code` for the hero image, video poster, or headline text that only renders after a client-side data fetch, with no SSR/prerender/static fallback ahead of it.
- [ ] The LCP candidate is sized and prioritised: `search_code` for that same element missing explicit `width`/`height` (or `aspect-ratio`), carrying `loading="lazy"` (which deprioritises exactly the element that must not be lazy), or lacking `fetchpriority="high"`/a preload hint.
- [ ] CLS-causing elements reserve their space: `search_code` for `<img>`/`<iframe>`/ad or embed slots with no `width`/`height`/`aspect-ratio`, and for content injected above existing content (a banner, a cookie notice, an async-loaded block) with no reserved slot.
- [ ] Web fonts do not cause layout shift on load: `Read` the `@font-face`/font-loading config for `font-display` — its absence, or `font-display: block`, causes an invisible-text or swap-triggered reflow; `swap`/`optional` paired with a size-matched fallback is the fix already in place if present.
- [ ] INP-risking work runs inside interaction handlers: reuse this module's own hot-path technique — `search_code` a click/input/keydown/submit handler for synchronous work that belongs off the main thread (a large synchronous loop, parsing a large payload, unbatched layout reads/writes).
- [ ] The project actually measures these in the field, not only assumes them from code shape: `search_code` for the `web-vitals` library import (or an equivalent RUM SDK reporting `LCP`/`INP`/`CLS`) wired to somewhere the numbers leave the browser (an analytics event, a beacon endpoint). Its absence means every check above is `inferred` against code shape only, with no field measurement anywhere — say so under Coverage Gaps rather than treating the absence itself as a performance defect.
- [ ] The codebase is not still optimising for a retired metric: `search_code` for `FID`/`first-input` tracked or referenced with no accompanying `INP`. FID (First Input Delay) was retired as a Core Web Vital on 12 March 2024, replaced by INP — code or a dashboard still keyed on FID alone is measuring a metric Google no longer scores.

## Out of static reach

- Actual LCP/INP/CLS percentile values from real users — nothing here runs Lighthouse or reads RUM data, only whether the code shape makes the thresholds reachable.
- Actual latency, throughput, or memory footprint under real traffic — nothing in this module is measured.
- The crossover input size at which an O(n²) block becomes user-visible, on the actual hardware and dataset.
- GC pause behaviour and allocator churn under sustained load.
- Whether a cache actually reduces latency in production, versus merely existing in the code.
- Cold-start time for serverless or lambda-style deployments — `browser.md`'s `vitals.md` TTFB on the first of its three cold-context runs *may* include a serverless cold start, but the reported median does not isolate it from ordinary first-request variance. The gap stays open; only that single-sample hint is available, and it is cited at `inferred`, not `traced`.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Every vitals-based row below is lab data, one machine; never a claim about real-user p75.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `vitals.md` | Lab LCP/CLS/INP score per flow against Google's thresholds — lab data, one machine; never a claim about real-user p75 | High |
| `trace.json`/`insights.md` | Long tasks and render-blocking requests actually present in a captured trace | High |
| `network.jsonl` | Real request waterfall (method, URL, status, size, duration) for the flow | Medium |

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
| LCP candidate blocked behind a client-only fetch, no SSR/prerender fallback | Medium |
| CLS-causing element with no reserved space | Medium |
| Expensive synchronous work inside an interaction handler on a ranked hot path | Medium |
| Repeated work hoistable out of a loop | Low |
| No field measurement (web-vitals/RUM) of Core Web Vitals at all | Low |
| Stale FID tracking with no INP replacement | Low |
