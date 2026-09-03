# AI

LLM and AI SDK integration. Gate: calls to an AI/LLM SDK were detected.

Two modules pair with this one: `Cost` (the same gate fires it) and `Privacy` (what leaves the process in a prompt). Audit them together or cross-reference explicitly.

Model IDs, token limits, and pricing drift faster than this file can be kept current. Every check below verifies the code against its own declared configuration, never against a remembered model name, limit, or price — if a check would require knowing today's real numbers, it does not belong here.

## Prompt construction

- [ ] Prompts live in one place, not scattered as inline string literals across call sites. `search_code` a distinctive prompt phrase to find the duplicates; more than one call site building the same prompt shape is the finding.
- [ ] User input is clearly delimited from instructions. `find_callees` on the prompt-construction function for a raw string concatenation of a user-supplied variable directly into the instruction text, with no delimiter — a tag, a separate message role, a fenced block. Concatenation with no delimiter is a prompt-injection vulnerability — the surface an attacker needs. Flag its absence as the finding; the attack itself still requires adversarial content in that input, which this check does not and cannot confirm — cross-reference `Abuse`. OWASP LLM01:2025 Prompt Injection and Greshake et al., "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection" (arXiv:2302.12173) — content injected into concatenated data can "manipulate the application's functionality, and control how and if other APIs are called." Rule out: input drawn from a closed, validated set (an enum, a whitelist, a dropdown selection) is not the finding even when concatenated raw — confirm the input is free text before flagging.
- [ ] Input length is bounded before it reaches the model. `find_callees` on the prompt-construction function for a truncation/chunking call between the raw input and the model call; its absence is both a denial-of-wallet risk (OWASP LLM10:2025 Unbounded Consumption — "the cost-per-use model of cloud-based AI services") and, when the unbounded input is untrusted, a wider surface for the injection risk named above — these are two different OWASP LLM Top 10 categories, not one.
- [ ] Prompts are versioned or at least dated. `search_code` for a version/date marker near the prompt constant or file; its absence means a behaviour change can never be correlated with which prompt produced it.

## Model contract

- [ ] The model identifier is configurable, not hardcoded at each call site. `search_code` the model-name string literal and count the call sites — more than one occurrence means a future migration touches N places.
- [ ] The code states which capabilities it depends on (tool use, structured output, context window). `find_symbol` the call site's request options and confirm the dependency is declared there or in an adjacent comment, not assumed silently. Tool use requires a declared `input_schema`, and `strict: true` on a tool definition guarantees the model's call matches that schema exactly (Anthropic tool-use documentation) — a declared dependency is what this check is confirming exists.
- [ ] Token limits are respected explicitly: input is truncated or chunked with a stated strategy. `find_callees` on the call site for a truncation/chunking step keyed to a declared limit, rather than a bare call left to fail at the API boundary. OWASP LLM10:2025 Unbounded Consumption names "Continuous Input Overflow" (inputs exceeding the context window) as a named exhaustion pattern this check closes.
- [ ] Where prompt caching is used, the `cache_control` breakpoint is `Read` at its call site to confirm it marks a block whose content is identical across requests, not one assembled from a timestamp, request id, or the latest user turn. A breakpoint on a per-request-unique block is a cache write on every call with no error surfaced — check the token-usage fields the client logs (`cache_read_input_tokens` vs `cache_creation_input_tokens`) for a hit rate of zero. Not the finding: the apparently-dynamic content actually sits after the marked block in assembly order, so the marked block genuinely is the stable prefix — read the block ordering, not just presence of dynamic-looking data nearby. Anthropic's prompt-caching documentation names exactly this as a common mistake: a breakpoint on a block that changes every request never finds a prior write, billing the write rate on every call with no error returned.
- [ ] Temperature and sampling are set deliberately where determinism matters. `search_code` the call site's options object; an omitted temperature on a call whose output feeds a downstream parser is the finding — an unset value is provider-chosen, not a decision anyone made.

## Output handling

- [ ] **Model output is untrusted input.** `find_callees` on the response-handling code for the output reaching `eval`, a shell command, a query, or a filesystem path with no validation in between. A model-generated path reaching `readFile` is `Critical`. OWASP LLM05:2025 Improper Output Handling: "treat the model as any other user, adopting a zero-trust approach" — the same risky-sink list this check enumerates (RCE, SQL injection, path traversal, XSS).
- [ ] Structured output is parsed defensively — malformed JSON is an expected case, not an exception. `find_callees` on the parse call for a surrounding try/catch or a result type distinguishing malformed output from a valid one; a bare parse call with no catch is the finding. Structured-output guarantees still leave a response that can be incomplete (max-token cutoff, safety interruption mid-generation) even when schema-conformant (OpenAI Structured Outputs documentation).
- [ ] There is a defined behaviour for a refusal, an empty response, and a truncated response. `find_symbol` the response handler and confirm each of the three cases has its own branch — a handler that only checks truthiness collapses all three into one path. A refusal surfaces via a dedicated field distinct from the schema (OpenAI's `refusal` field is the documented example) — a handler with no branch for it silently treats a refusal as valid parsed output.
- [ ] Hallucination-sensitive outputs (file paths, symbol names, citations) are verified against reality before being acted on or shown. `find_callees` on the code consuming such output for a verification step (a filesystem check, a symbol lookup) before the value is used. OWASP LLM05:2025's zero-trust framing applies here too: an unverified model-generated reference is treated as fact without the check this line requires.

## Failure and degradation

- [ ] Every model call has a timeout and a bounded, backed-off retry — owned by `failure.md` (`Read` the client construction/call site for a `timeout` option or `AbortSignal.timeout`, and a retry wrapper's backoff config); reuse its finding, do not re-report. A model call is an external call like any other for this angle.
- [ ] Rate limits and quota errors are distinguished from real failures and handled differently. `find_callees` on the error handler for a status-code or error-type branch specific to rate-limit/quota, versus a single generic catch-all. The retry/backoff wrapper, `Read` at its error-branch, must also distinguish a spend-cap-reached error from an ordinary rate limit before retrying — both return `error.type: "rate_limit_error"`, but only the rate limit carries a `retry-after` header and a transient cause (Anthropic's rate-limits documentation: a spend-cap error carries no `retry-after` and "retrying... fails until access resumes" at the start of the next calendar month). A wrapper that retries any `rate_limit_error` uniformly will keep retrying a spend-cap block that cannot succeed until next month; the wrapper's own max-retry count and backoff ceiling already bounding the wasted calls to a handful is not the finding — read those constants before treating the blind retry as a real cost concern.
- [ ] There is a degraded path when the provider is unavailable — a cheaper model, a cached answer, or an honest error. `find_callees` on the call site's catch block for a fallback path; a bare rethrow with nothing downstream to handle it is silent failure, the worst option.
- [ ] Streaming responses handle mid-stream disconnection without leaving partial state committed. `find_callees` on the stream consumer for a cleanup/rollback path on stream error, not only on stream completion. The stream-error/reconnect handler, `find_callees` from the error branch, must never route a partially-received `tool_use` block to the tool-execution path before the stream reaches a completed `stop_reason` — recovery re-sends or resumes text content only. A path where resume logic can trigger a second dispatch of a side-effecting tool is the finding; Anthropic's streaming documentation: "Tool use and extended thinking blocks cannot be partially recovered." Not the finding: the tool reached by the resumed dispatch is read-only or idempotent, so even a duplicate call has no observable side effect — confirm the tool's own idempotency before flagging.

## Tool execution boundary

- [ ] A tool call whose name or effect is destructive (delete, deploy, migrate, send, pay, publish) reaches its downstream sink through an authorization or confirmation check the model's own output cannot satisfy. `find_callees` on the tool-dispatch function for a permission/allow-list/human-confirmation step between the model's `tool_use` block and the sink; a call path with none is the finding. Cross-reference `Abuse` and `security.md`. OWASP LLM06:2025 Excessive Agency: "fails to independently verify and approve high-impact actions"; mitigation is to "enforce authorization in the downstream system, not in the LLM's own decision." Not the finding: the action requires a separate human-originated UI event outside the model's own tool-calling turn (a person clicks "confirm" through a control the model cannot invoke) — rule this out by checking whether the call graph from `tool_use` to the sink can complete in one turn with no human-side entry point in between.
- [ ] A tool or MCP server's declared capability set is no broader than what the code's call sites actually invoke. `search_code` the tool/extension registration for its declared scope, then `find_callers` on each declared capability to confirm the code path that would use it exists; a declared write/delete/admin capability with no corresponding call site is the finding. OWASP LLM06:2025's excessive-functionality and excessive-permissions root causes are exactly this over-grant pattern. Not the finding: the unused capability is kept for a documented, currently-disabled flow (a feature flag, a beta path) — confirm no such flag exists before flagging as pure over-grant.

## Evaluation

- [ ] Some check exists that the AI feature still works — golden tests, snapshot comparisons, or a manual procedure that is written down. `search_code` the test directory for a golden-file, snapshot, or fixture referencing the prompt/model call; its absence in a project with tests elsewhere is the finding. Anthropic's own eval-design guidance: task-specific, automated grading over hand-graded assertions.
- [ ] Non-determinism is handled in tests: either a fake client (assert the request, not the response) or tolerance-based assertions. Read the test found above — an assertion on exact model prose, rather than on the request sent or a tolerance/schema check on the response, is a flake generator. Anthropic's eval-design guidance: non-determinism is handled with large test sets and semantic grading (embedding cosine similarity, ROUGE-L, LLM-based rubric scoring), not exact-string assertions on model prose.

## Out of static reach

- Actual model behaviour on adversarial input — whether a delimiter or guard genuinely resists injection can only be shown by running attacks against the live model.
- Real token counts and cost per call — these depend on the provider's tokenizer and current pricing, neither visible from source.
- Whether the declared timeout/retry values are well-tuned for the provider's real latency distribution.
- Actual output quality or hallucination rate — this requires running the eval suite, not reading it — closed by `runtime.md` when execution is enabled and the project's declared test command includes the golden/eval suite named under Evaluation above.
- Provider-side rate limits and quota — these live in the provider account, not the repository.
- Whether prompt caching actually pays off at production traffic volume — this module can only confirm the breakpoint is placed on stable content, not that it is hit often enough to matter.
- Whether a connected tool server does only what its declared schema says — this module reads the client's side of the contract, not the server's implementation.
- Whether a required human confirmation step is meaningfully reviewed before being clicked through — this module can confirm the gate exists, not that it is used with judgement.
- Whether the declared token-limit handling is exercised often in practice, or is dead code for inputs that never get that large — this module cannot see production input sizes.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Provider API key reachable from the browser — a page-initiated JS request to a known provider API host (e.g. an `api.anthropic.com`/`api.openai.com`-class host) carrying an API-key-shaped header, not a same-origin proxy path. Refuted if the request's initiator is a same-origin path proxied server-side | Critical |
| `screenshots/` + `console.jsonl` | A refusal, empty, or truncated model response renders as raw JSON, a blank pane, or an uncaught client error, on a confirmed AI-feature flow. Refuted if the flow's own steps never actually produced a refusal/truncation — report as not observed, not as clean | High |
| `steps.md` + `screenshots/` | A streaming AI response hangs with no timeout surfaced to the user — elapsed-time capture plus a stuck loading/typing indicator past the flow's own step boundary. Refuted if the hang resolves within the flow's own recorded step time | Medium |

## Severity guidance

| Situation | Severity |
|---|---|
| Model output reaching `eval`, a shell, a query, or a path | Critical |
| User input concatenated into an instruction block unbounded | High |
| No validation of structured output before use | High |
| No degraded path when the provider is down | Medium |
| Model identifier hardcoded at multiple call sites | Medium |
| No evaluation of the AI feature at all | Medium |
| Prompts duplicated as inline literals | Low |
| Destructive tool call reaches its sink with no authorization/confirmation gate between `tool_use` and the sink (traced) | Critical |
| Partially-streamed `tool_use` block re-dispatched to a side-effecting tool on stream resume (traced) | High |
| Retry wrapper retries a spend-cap 429 the same way as a rate-limit 429 | Medium |
| Declared tool/MCP capability broader than any call site actually invokes | Medium |
| Prompt-cache breakpoint placed on per-request-unique content (zero hit rate) | Medium |
