# API

The contract as seen from outside. Gate: a server framework or API routes were detected. Distinct from `Backend` — that module audits how the server works, this one audits what it promises.

## Surface inventory

- [ ] Enumerate every externally reachable endpoint, tool, or exported entry point. `search_code` the route-registration call, then `find_callers` on each handler.
- [ ] Each one is documented, or deliberately internal. An undocumented public endpoint is either an accident or a private API someone will depend on anyway.
- [ ] No endpoint exists that the docs do not mention and no client calls — that belongs to `Reachability`, cross-reference it.

## Contract shape

- [ ] Naming and pluralisation are consistent across the surface. `/users/:id` next to `/getAccount` is two conventions.
- [ ] Status codes are used for their meaning: not 200-with-error-body, not 500 for validation failure.
- [ ] Error responses share one shape, and it includes something machine-readable — a code, not only prose.
- [ ] Pagination exists wherever a collection can grow, and it is the same mechanism everywhere.
- [ ] Field names and types are stable across endpoints. The same concept should not be `userId` here and `user_id` there.

## Input contract

- [ ] Every parameter's type, required-ness, and bounds are declared, and the declaration is what actually validates. A schema that documents but does not enforce is worse than none.
- [ ] Unknown fields are rejected or ignored deliberately, not silently accepted and dropped.
- [ ] Defaults are documented, and the documented default matches the code.

## Compatibility

- [ ] Breaking changes are versioned or gated. Compare the current shape against any published schema, generated client, or `openapi`/`graphql` artefact — that comparison belongs to `Contract Drift` if that gate is on.
- [ ] Optional fields are genuinely optional in every consumer. `find_callers` on the response type to see who destructures what.
- [ ] Removed or renamed fields have a deprecation path.

## Discoverability

- [ ] A caller can find the full surface without reading the source. If not, that is the finding.
- [ ] Examples in the docs are executable and current. Test one against the real signature.
- [ ] Auth requirements are stated per endpoint, not only globally.

## Severity guidance

| Situation | Severity |
|---|---|
| Declared schema does not actually enforce input | High |
| Breaking change shipped with no version or gate | High |
| Undocumented endpoint reachable externally | Medium |
| Collection endpoint with no pagination | Medium |
| Inconsistent error shape across the surface | Medium |
| Naming convention drift | Low |
| Docs example that no longer matches the signature | Low |
