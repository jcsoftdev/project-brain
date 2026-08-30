# API

The contract as seen from outside. Gate: a server framework or API routes were detected. Distinct from `Backend` — that module audits how the server works, this one audits what it promises.

## Surface inventory

- [ ] Enumerate every externally reachable endpoint, tool, or exported entry point. `search_code` the route-registration call (`router.`, `app.get(`, `@Get(`, a tool/handler registry), then `find_callers` on each handler to confirm nothing routes to it a second time through a separate registration.
- [ ] Each one is documented, or deliberately internal. Cross-check the inventory above against the docs/OpenAPI artefact located by `search_code` for `openapi`, `swagger`, or `.graphql` — an endpoint present in one list and absent from the other is the finding.
- [ ] No endpoint exists that the docs do not mention and no client calls — that belongs to `Reachability`, cross-reference it rather than re-deriving it here.

## Contract shape

- [ ] Naming and pluralisation are consistent across the surface. Diff the path list from the inventory above literally — `/users/:id` next to `/getAccount` is two conventions in one surface.
- [ ] Status codes are used for their meaning. `search_code` for a `200`/`res.status(200)` literal returned alongside an error-shaped body, or a `500` returned for what the handler logic shows is a validation failure.
- [ ] Error responses share one shape, and it includes something machine-readable — a code, not only prose. `search_code` the error-construction call across handlers; more than one shape is the finding — cross-reference `Backend`'s request-lifecycle check, and report the value divergence here.
- [ ] Pagination exists wherever a collection can grow, and it is the same mechanism everywhere. `search_code` for `limit`/`cursor`/`offset` parameters across list-returning endpoints; a collection endpoint with none of them is the finding. Where the mechanism is offset-based (`page=`/`offset=`) on a collection that also takes concurrent inserts or deletes, note it as a correctness risk, not only a performance one — a row can be skipped or duplicated across pages when the underlying set shifts mid-pagination, independent of how deep the paging goes; cursor/keyset pagination (a `WHERE (sort_col, id) < (last_seen...)` filter) does not have this failure mode because it tracks a data value, not a row position.
- [ ] Field names and types are stable across endpoints. `find_symbol` the response type for the same concept in two endpoints and diff them — `userId` here and `user_id` there is two vocabularies.

## Input contract

- [ ] Every parameter's type, required-ness, and bounds are declared, and the declaration is what actually validates. `find_symbol` the schema, then confirm the handler calls `.parse()`/`.validate()` on it rather than importing the type only for documentation.
- [ ] Unknown fields are rejected or ignored deliberately, not silently accepted and dropped. `find_symbol` the schema's strict/passthrough setting — its absence is the validator's default, not a decision anyone made.
- [ ] Defaults are documented, and the documented default matches the code. `find_symbol` the schema's default value and diff it against the docs' stated default.

## Compatibility

- [ ] Breaking changes are versioned or gated. Compare the current shape against any published schema, generated client, or `openapi`/`graphql` artefact via `search_code` — that comparison belongs to `Contract Drift` if that gate is on; cross-reference rather than re-running it here.
- [ ] The versioning mechanism is one scheme, not a mix chosen ad hoc per endpoint. `search_code` the route prefixes (`/v1/`, `/v2/`) and any `Accept`-header or custom version-header handling across the surface — URI, header, and media-type versioning are all legitimate choices (URI is the most operationally common for public APIs — cache-friendly, visible in logs), but one endpoint quietly branching on a header nobody else uses is the finding, not the choice of mechanism itself.
- [ ] Optional fields are genuinely optional in every consumer. `find_callers` on the response type to see who destructures the field with no null check.
- [ ] Removed or renamed fields, and endpoints scheduled for removal, have a deprecation path. For an HTTP surface: `search_code` for a `Deprecation` response header being set (RFC 9745 — a Structured Field date, not a free-text string) and, once a removal date exists, a `Sunset` header (RFC 8594) whose date is never earlier than the `Deprecation` header's own date on the same response. For a non-HTTP surface: `search_code` for a `deprecated` marker or doc comment near the field the code no longer sets. Absence on a field or endpoint the docs mark deprecated is the finding.

## Discoverability

- [ ] A caller can find the full surface without reading the source. Confirm a docs/OpenAPI artefact exists and its endpoint count matches the inventory count above; a mismatch is the finding.
- [ ] Examples in the docs are executable and current. `find_symbol` the referenced handler's real signature and diff it against the documented example's parameters.
- [ ] Auth requirements are stated per endpoint, not only globally. `search_code` the docs/OpenAPI security annotations per path, then `find_callees` on the handler for an auth middleware in code with no matching stated requirement in docs.

## Out of static reach

- Whether the documented examples were actually executed against a running server recently, versus copy-pasted once and never rerun.
- Real client behaviour on an unknown field — whether a consumer silently ignores it or crashes depends on the client's own parser, not this repository.
- Actual latency or throughput of paginated versus unpaginated responses.
- Whether external consumers exist at all for an endpoint marked "internal" — that requires visibility outside this repository.

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
| Offset pagination on a frequently-mutated collection, no cursor alternative | Low |
| Versioning mechanism mixed inconsistently across the surface | Low |
