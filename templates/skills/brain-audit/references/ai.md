# AI

LLM and AI SDK integration. Gate: calls to an AI/LLM SDK were detected.

Two modules pair with this one: `Cost` (the same gate fires it) and `Privacy` (what leaves the process in a prompt). Audit them together or cross-reference explicitly.

Model IDs, token limits, and pricing drift faster than this file can be kept current. Every check below verifies the code against its own declared configuration, never against a remembered model name, limit, or price — if a check would require knowing today's real numbers, it does not belong here.

## Prompt construction

- [ ] Prompts live in one place, not scattered as inline string literals across call sites. `search_code` a distinctive prompt phrase to find the duplicates; more than one call site building the same prompt shape is the finding.
- [ ] User input is clearly delimited from instructions. `find_callees` on the prompt-construction function for a raw string concatenation of a user-supplied variable directly into the instruction text, with no delimiter — a tag, a separate message role, a fenced block. Concatenation with no delimiter is prompt injection — cross-reference `Abuse`.
- [ ] Input length is bounded before it reaches the model. `find_callees` on the prompt-construction function for a truncation/chunking call between the raw input and the model call; its absence is both an injection surface and an unbounded bill.
- [ ] Prompts are versioned or at least dated. `search_code` for a version/date marker near the prompt constant or file; its absence means a behaviour change can never be correlated with which prompt produced it.

## Model contract

- [ ] The model identifier is configurable, not hardcoded at each call site. `search_code` the model-name string literal and count the call sites — more than one occurrence means a future migration touches N places.
- [ ] The code states which capabilities it depends on (tool use, structured output, context window). `find_symbol` the call site's request options and confirm the dependency is declared there or in an adjacent comment, not assumed silently.
- [ ] Token limits are respected explicitly: input is truncated or chunked with a stated strategy. `find_callees` on the call site for a truncation/chunking step keyed to a declared limit, rather than a bare call left to fail at the API boundary.
- [ ] Temperature and sampling are set deliberately where determinism matters. `search_code` the call site's options object; an omitted temperature on a call whose output feeds a downstream parser is the finding — an unset value is provider-chosen, not a decision anyone made.

## Output handling

- [ ] **Model output is untrusted input.** `find_callees` on the response-handling code for the output reaching `eval`, a shell command, a query, or a filesystem path with no validation in between. A model-generated path reaching `readFile` is `Critical`.
- [ ] Structured output is parsed defensively — malformed JSON is an expected case, not an exception. `find_callees` on the parse call for a surrounding try/catch or a result type distinguishing malformed output from a valid one; a bare parse call with no catch is the finding.
- [ ] There is a defined behaviour for a refusal, an empty response, and a truncated response. `find_symbol` the response handler and confirm each of the three cases has its own branch — a handler that only checks truthiness collapses all three into one path.
- [ ] Hallucination-sensitive outputs (file paths, symbol names, citations) are verified against reality before being acted on or shown. `find_callees` on the code consuming such output for a verification step (a filesystem check, a symbol lookup) before the value is used.

## Failure and degradation

- [ ] Every model call has a timeout and a bounded retry with backoff. `find_symbol` the client construction/call site for a timeout option and a retry wrapper; either missing is `High`.
- [ ] Rate limits and quota errors are distinguished from real failures and handled differently. `find_callees` on the error handler for a status-code or error-type branch specific to rate-limit/quota, versus a single generic catch-all.
- [ ] There is a degraded path when the provider is unavailable — a cheaper model, a cached answer, or an honest error. `find_callees` on the call site's catch block for a fallback path; a bare rethrow with nothing downstream to handle it is silent failure, the worst option.
- [ ] Streaming responses handle mid-stream disconnection without leaving partial state committed. `find_callees` on the stream consumer for a cleanup/rollback path on stream error, not only on stream completion.

## Evaluation

- [ ] Some check exists that the AI feature still works — golden tests, snapshot comparisons, or a manual procedure that is written down. `search_code` the test directory for a golden-file, snapshot, or fixture referencing the prompt/model call; its absence in a project with tests elsewhere is the finding.
- [ ] Non-determinism is handled in tests: either a fake client (assert the request, not the response) or tolerance-based assertions. Read the test found above — an assertion on exact model prose, rather than on the request sent or a tolerance/schema check on the response, is a flake generator.

## Out of static reach

- Actual model behaviour on adversarial input — whether a delimiter or guard genuinely resists injection can only be shown by running attacks against the live model.
- Real token counts and cost per call — these depend on the provider's tokenizer and current pricing, neither visible from source.
- Whether the declared timeout/retry values are well-tuned for the provider's real latency distribution.
- Actual output quality or hallucination rate — this requires running the eval suite, not reading it.
- Provider-side rate limits and quota — these live in the provider account, not the repository.

## Severity guidance

| Situation | Severity |
|---|---|
| Model output reaching `eval`, a shell, a query, or a path | Critical |
| User input concatenated into an instruction block unbounded | High |
| No timeout on a model call | High |
| No validation of structured output before use | High |
| No degraded path when the provider is down | Medium |
| Model identifier hardcoded at multiple call sites | Medium |
| No evaluation of the AI feature at all | Medium |
| Prompts duplicated as inline literals | Low |
