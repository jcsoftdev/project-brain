# AI

LLM and AI SDK integration. Gate: calls to an AI/LLM SDK were detected.

Two modules pair with this one: `Cost` (the same gate fires it) and `Privacy` (what leaves the process in a prompt). Audit them together or cross-reference explicitly.

## Prompt construction

- [ ] Prompts live in one place, not scattered as inline string literals across call sites. `search_code` a distinctive prompt phrase to find the duplicates.
- [ ] User input is clearly delimited from instructions. Concatenating untrusted text directly into an instruction block is prompt injection — cross-reference `Abuse`.
- [ ] Input length is bounded before it reaches the model. Unbounded user text is both an injection surface and an unbounded bill.
- [ ] Prompts are versioned or at least dated. An undated prompt cannot be correlated with a behaviour change.

## Model contract

- [ ] The model identifier is configurable, not hardcoded at each call site. `search_code` the model name string — more than one occurrence means a future migration touches N places.
- [ ] The code states which capabilities it depends on (tool use, structured output, context window). A silent downgrade to a weaker model then fails mysteriously.
- [ ] Token limits are respected explicitly: input is truncated or chunked with a stated strategy, not left to fail at the API boundary.
- [ ] Temperature and sampling are set deliberately where determinism matters.

## Output handling

- [ ] **Model output is untrusted input.** It is validated against a schema before use, never `eval`'d, never interpolated into a query, a shell command, or a filesystem path. A model-generated path reaching `readFile` is `Critical`.
- [ ] Structured output is parsed defensively — malformed JSON is an expected case, not an exception.
- [ ] There is a defined behaviour for a refusal, an empty response, and a truncated response.
- [ ] Hallucination-sensitive outputs (file paths, symbol names, citations) are verified against reality before being acted on or shown.

## Failure and degradation

- [ ] Every model call has a timeout and a bounded retry with backoff.
- [ ] Rate limits and quota errors are distinguished from real failures and handled differently.
- [ ] There is a degraded path when the provider is unavailable — a cheaper model, a cached answer, or an honest error. Silent failure is the worst option.
- [ ] Streaming responses handle mid-stream disconnection without leaving partial state committed.

## Evaluation

- [ ] Some check exists that the AI feature still works — golden tests, snapshot comparisons, or a manual procedure that is written down. A prompt with no evaluation regresses invisibly on the next model update.
- [ ] Non-determinism is handled in tests: either a fake client (assert the request, not the response) or tolerance-based assertions. A test asserting exact model prose is a flake generator.

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
