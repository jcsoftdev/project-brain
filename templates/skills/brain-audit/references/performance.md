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
- [ ] `JSON.stringify`/`JSON.parse` called on a payload with no declared size bound (no upstream `LIMIT`/pagination narrowing it) inside a request handler: `search_code` for the call, cross-referenced with the pagination check above. Earns no severity above `Low` on its own, per this module's own hot-path rule — anchor to a `repo_map` rank or a `find_callers` count showing high request volume before raising it. Refuted if the payload size is bounded by construction (a fixed-shape config object, not a query result) — state the bound. `JSON.stringify` on a 50MB object took 0.7 seconds and `JSON.parse` took 1.3 seconds in Node's own benchmark — the concrete number behind "large payload" (Node.js (OpenJS Foundation), "Don't Block the Event Loop" guide, current, https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).
- [ ] Synchronous filesystem or crypto calls on a request path: `search_code` for `readFileSync`, `writeFileSync`, `execSync`, `*Sync(` inside a handler, then `find_callers` to confirm the handler is reached from a route rather than a CLI or build script — the same call is a non-issue in a one-shot script. Sync crypto (`randomBytes`, `pbkdf2Sync`), sync zlib, and sync fs all block the event loop the same way (Node.js (OpenJS Foundation), "Don't Block the Event Loop" guide, current, https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).
- [ ] Extend the check above to `zlib`'s sync API (`inflateSync`/`deflateSync`/`gzipSync`/`gunzipSync`) and to nested-quantifier regex literals (patterns like `(.+)+`, `(.*)*`, `([a-zA-Z]+)*`) reachable from a request handler: `search_code` for the pattern, then `find_callers` to confirm the handler is reached from an HTTP route rather than a CLI or build script. Refuted if the regex only ever runs against a fixed, developer-authored string (never user input), or input length is bounded upstream (a max-length validator before the match) — either rules out the exponential-time case. Node's own docs name catastrophic-backtracking regex and sync zlib as event-loop-blocking hazards and explicitly frame the regex case as a Denial-of-Service vector, not just a slowness one ("a malicious client could submit this 'evil input', make your threads block" — Node.js (OpenJS Foundation), "Don't Block the Event Loop" guide, current, https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).

## CPU-bound work

- [ ] CPU-intensive synchronous work (image/PDF processing, hashing loops, matrix or crypto computation) inside a request handler with no `worker_threads` import anywhere in the same module: `search_code` for the heavy computation call, then `find_callers` to confirm the handler is reached from a route, not a CLI/build script — the same code is a non-issue off the request path. Refuted if the computation is bounded to a size trivial enough that it never approaches the 50ms Long Task threshold — state the bound and why it holds; or the work already runs in a queue/worker process outside this codebase (a job runner, a separate service) that `find_callees` shows the handler only enqueues into. Workers "are useful for performing CPU-intensive JavaScript operations. They do not help much with I/O-intensive work" (Node.js (OpenJS Foundation), official API documentation, current, https://nodejs.org/api/worker_threads.html); a Long Task is main-thread work exceeding 50ms, and that is the number "expensive" means here (web.dev (Google), official vendor documentation, current, https://web.dev/articles/long-tasks-devtools).

## Memory

- [ ] Unbounded accumulation: `search_code` for a module-level `Map`/`Set`/array populated via `.push`/`.set` with no matching eviction, `maxSize`, or TTL nearby. Rule out that the key space is bounded by construction — a fixed set of feature flags is not user input.
- [ ] Whole-result materialisation where a stream or iterator would do: `search_code` for `.toArray()`/`.fetchAll()`/`readFileSync` used against a source with no declared size cap.
- [ ] Retained references that outlive their use: `search_code` for `addEventListener`/subscription calls with no paired `removeEventListener`/`unsubscribe`; `find_callers` on the owning object to check whether it is ever torn down.
- [ ] Large allocations in a loop that the allocator will churn on: `search_code` for `new Array(`, `Buffer.alloc(`, or an object/array literal constructed inside a loop body.

## Caching

- [ ] Every cache has a stated key, a stated lifetime, and an invalidation path: `search_code` the cache import (`lru-cache`, `node-cache`, a hand-rolled `Map`), then read the set/get sites for a TTL and an explicit invalidation call. A cache with no invalidation is a correctness bug wearing a performance costume. Rule out a content-addressed key (a hash of the cached value or an immutable source) — invalidation is meaningless when the key already changes whenever the value would. A cache "MUST invalidate the target URI when it receives a non-error status code in response to an unsafe request method" (IETF, RFC 9111 §4.4, 2022, https://www.rfc-editor.org/rfc/rfc9111.html).
- [ ] A PUT/PATCH/DELETE handler that mutates a resource with no invalidation call touching the same cache key(s) the matching GET handler populates: `search_code` the cache import (same search as the check above) for its `set`/`get` sites, then `find_callers` on the invalidation function to confirm no unsafe-method handler calls it. Refuted if the cache key is content-addressed (a hash of the value itself) so the old entry is simply never read again once the value changes — same refutation as the check above. This is the mutation-triggered half RFC 9111 §4.4 names explicitly: "a cache MUST invalidate the target URI when it receives a non-error status code in response to an unsafe request method" (IETF, RFC 9111, 2022, https://www.rfc-editor.org/rfc/rfc9111.html).
- [ ] A GET endpoint serving content that does not vary per request (a public listing, a computed report, a static asset route) with no `Cache-Control`, `Expires`, or equivalent freshness directive in the response: `search_code` for the route's response-header calls. Refuted if the endpoint's response legitimately varies per caller (personalised, includes a CSRF token, or reflects request-specific state) and must not be cached — state which. Per RFC 9111 §3, a cache "MUST NOT store a response" unless it carries at least one of a `public`/`private` directive, an `Expires` header, or a `max-age` directive — cacheability requires an explicit directive, absence is not a safe default (IETF, RFC 9111, 2022, https://www.rfc-editor.org/rfc/rfc9111.html).
- [ ] Cache keys include everything the value depends on: `find_symbol` the cached function's signature, then read the key expression — a parameter missing from the key means two distinct inputs collide on one cache entry and one of them gets served the wrong answer.
- [ ] Cached values that are cheap to compute: `Read` the wrapped function — a single arithmetic expression or constant lookup means the cache costs more in complexity than it saves.
- [ ] Nothing caches a mutable object by reference and lets a caller mutate it: `find_callers` on the cache getter, then check whether any caller mutates the returned object in place.

## Startup

- [ ] Nothing expensive happens at import time: `search_code` for a function call or `new Client(`/`.connect(` sitting at module scope rather than inside an exported function. `find_callers` on the module to rule out that it is only ever imported by the entry point itself, where the cost is paid once regardless of what runs.
- [ ] Heavy dependencies are imported lazily at the point of need: `search_code` a known heavy import (image processing, PDF, a large SDK) at the top of a file, then `find_callers` on that file's export to confirm the code path is rarely reached. A static top-level import on a cold path is the finding; a dynamic `import()` at the call site is the fix already in place.

## Frontend rendering (Core Web Vitals)

Applies only when the project serves HTML to a browser — cross-reference the `Web Metadata` gate. Skip this section entirely, and say so, for a pure API/backend/CLI project. The current Core Web Vitals (Google, stable since March 2024) are LCP, INP, and CLS, each scored at the 75th percentile of real-user field data: LCP good ≤2.5s/poor >4.0s, INP good ≤200ms/poor >500ms, CLS good ≤0.1/poor >0.25. None of these are measurable statically — every check below is code shape, not a score. With `browser.md` enabled, `vitals.md` supplies a lab score per flow; see What browser observation closes.

- [ ] The LCP candidate is not blocked behind avoidable work: `search_code` for the hero image, video poster, or headline text that only renders after a client-side data fetch, with no SSR/prerender/static fallback ahead of it. Client-side-rendered content delays LCP because the LCP resource must be discoverable directly from HTML source, not from JS/CSS parsing (web.dev (Google), official vendor documentation, current, https://web.dev/articles/optimize-lcp).
- [ ] The LCP candidate is sized and prioritised: `search_code` for that same element missing explicit `width`/`height` (or `aspect-ratio`), carrying `loading="lazy"` (which deprioritises exactly the element that must not be lazy), or lacking `fetchpriority="high"`/a preload hint. "Never lazy-load your LCP image, as that will always lead to unnecessary resource load delay" (web.dev (Google), official vendor documentation, current, https://web.dev/articles/optimize-lcp).
- [ ] CLS-causing elements reserve their space: `search_code` for `<img>`/`<iframe>`/ad or embed slots with no `width`/`height`/`aspect-ratio`, and for content injected above existing content (a banner, a cookie notice, an async-loaded block) with no reserved slot. "The cause of layout shifts might be images or videos with unknown dimensions, fonts that render larger or smaller than its initial fallback, or third-party ads or widgets that dynamically resize themselves" (web.dev (Google), official vendor documentation, current, https://web.dev/articles/cls).
- [ ] Web fonts do not cause layout shift on load: `Read` the `@font-face`/font-loading config for `font-display` — its absence, or `font-display: block`, causes an invisible-text or swap-triggered reflow; `swap`/`optional` paired with a size-matched fallback is the fix already in place if present (MDN Web Docs (Mozilla), official reference documentation, current, https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display).
- [ ] INP-risking work runs inside interaction handlers: reuse this module's own hot-path technique — `search_code` a click/input/keydown/submit handler for synchronous work that belongs off the main thread (a large synchronous loop, parsing a large payload, unbatched layout reads/writes). "An input delay occurs until event handlers start running, possibly caused by factors such as long tasks on the main thread" (web.dev (Google), official vendor documentation, current, https://web.dev/articles/inp); a Long Task is main-thread work exceeding 50ms (web.dev (Google), official vendor documentation, current, https://web.dev/articles/long-tasks-devtools).
- [ ] The project actually measures these in the field, not only assumes them from code shape: `search_code` for the `web-vitals` library import (or an equivalent RUM SDK reporting `LCP`/`INP`/`CLS`) wired to somewhere the numbers leave the browser (an analytics event, a beacon endpoint). Its absence means every check above is `inferred` against code shape only, with no field measurement anywhere — say so under Coverage Gaps rather than treating the absence itself as a performance defect. Field measurement is "the primary way to evaluate these metrics" because performance "can substantially vary based on a user's device capabilities, their network conditions... and how they're interacting with the page" (web.dev (Google), official vendor documentation, current, https://web.dev/articles/vitals).
- [ ] The codebase is not still optimising for a retired metric: `search_code` for `FID`/`first-input` tracked or referenced with no accompanying `INP`. FID (First Input Delay) was retired as a Core Web Vital on 12 March 2024, replaced by INP — code or a dashboard still keyed on FID alone is measuring a metric Google no longer scores ("INP will officially become a Core Web Vital and replace FID on March 12" — web.dev (Google), official vendor blog, 2024, https://web.dev/blog/inp-cwv-march-12).

## Out of static reach

- Actual LCP/INP/CLS percentile values from real users — nothing here runs Lighthouse or reads RUM data, only whether the code shape makes the thresholds reachable.
- Actual latency, throughput, or memory footprint under real traffic — nothing in this module is measured.
- The crossover input size at which an O(n²) block becomes user-visible, on the actual hardware and dataset.
- GC pause behaviour and allocator churn under sustained load.
- Whether a cache actually reduces latency in production, versus merely existing in the code.
- Cold-start time for serverless or lambda-style deployments — `browser.md`'s `vitals.md` TTFB on the first of its three cold-context runs *may* include a serverless cold start, but the reported median does not isolate it from ordinary first-request variance. The gap stays open; only that single-sample hint is available, and it is cited at `inferred`, not `traced`.
- Utilization, saturation and error rate per resource, per the USE method — this audit has no profiler or OS monitor, so it cannot check whether a resource is actually saturated in production, only whether the code shape could let one become so.
- Whether a flagged query is actually slow — that requires reading its execution plan, which is `Database`'s check, not this module's.
- Whether a hot function stays JIT-optimized or gets deoptimized under real load — that is runtime engine behaviour this audit cannot see from source.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Every vitals-based row below is lab data, one machine; never a claim about real-user p75.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `vitals.md` | Lab LCP/CLS/INP score per flow against Google's thresholds. A score just over threshold on one of three cold runs is noise, not a finding, unless it holds across all three. | High |
| `trace.json`/`insights.md` | Long task (>50ms) actually present and overlapping a real interaction during a flow. Refuted if the long task does not overlap an input event's timestamp — check interaction timing in `insights.md` before citing it against INP. | High |
| `insights.md` (RenderBlocking / LCP breakdown insight) | Render-blocking resource actually delaying the LCP candidate's paint. Refuted if the resource finishes loading before the LCP candidate would have painted anyway — read the LCP phase breakdown, not just the resource's presence, before flagging. | High |
| `trace.json` (layout-shift entries) corroborated by `screenshots/` diff | CLS-causing element (missing width/height, injected content, font swap) actually shifts layout in this run. A code-shape risk that never actually shifts in this run — because it loads before layout, or never enters the viewport walked — stays `inferred`/`read` at code level; it is not upgraded to `observed` just because the code pattern exists. | High when an actual shift is recorded; the code-shape absence alone stays at the module's existing `read`/`inferred` ceiling |
| `network.jsonl` | Real request waterfall: TTFB and slow API calls actually blocking a flow's render or interaction. Refuted if the slow request starts after the paint/interaction it would have blocked — confirm ordering against `steps.md` timestamps before citing it. | Medium |
| `resource-perf.md` | Unused JS bytes / oversized JS payload against the HTTP Archive 2024 median (613KB desktop / 558KB mobile — HTTP Archive, Web Almanac 2024, Performance chapter, 2024, https://almanac.httparchive.org/en/2024/performance). Refuted if heavy or unused code is lazy-loaded off the critical path, per `insights.md` — it did not cost this flow anything even if the byte count is high. | Low |
| `network.jsonl` (response headers) | `Cache-Control`/freshness header actually present or absent on a request seen live — extends the static Caching check from `read` toward `observed`. Refuted if the route serves a personalised or CSRF-bearing response that must not be cached — same refutation as the static check. | Low |
| `vitals.md`'s three recorded cold runs | Whether a perf finding is a real regression or single-run noise. A metric that only crosses a threshold on one of three runs is noise; a finding is reportable only when it holds across the recorded set — this governs Confidence and reportability, not severity. | n/a (gates reportability) |

## Severity guidance

| Situation | Severity |
|---|---|
| Unbounded memory growth reachable from user input | High |
| Missing pagination on an endpoint over a growing table | High |
| Cache with no invalidation serving stale correctness-sensitive data | High |
| Mutating handler with no invalidation call on the matching cached read's key | High |
| Catastrophic-backtracking regex or synchronous zlib call reachable from a request handler | High |
| Sequential awaits over independent I/O on a hot path | Medium |
| O(n²) reachable at realistic input sizes | Medium |
| Synchronous I/O on a request path | Medium |
| Expensive work at import time | Medium |
| LCP candidate blocked behind a client-only fetch, no SSR/prerender fallback | Medium |
| CLS-causing element with no reserved space | Medium |
| Expensive synchronous work inside an interaction handler on a ranked hot path | Medium |
| CPU-intensive synchronous work on a request path with no worker-thread offload | Medium |
| Repeated work hoistable out of a loop | Low |
| No field measurement (web-vitals/RUM) of Core Web Vitals at all | Low |
| Stale FID tracking with no INP replacement | Low |
| Large `JSON.stringify`/`JSON.parse` on an unbounded payload, not anchored to a confirmed hot path | Low |
| Cacheable GET endpoint with no `Cache-Control`/`Expires`/freshness directive | Low |
