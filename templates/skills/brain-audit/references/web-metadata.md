# Web Metadata

What does this page tell a machine that is not the user's browser? Gate: the project serves HTML to a browser.

`accessibility.md` owns the document's semantics for assistive technology — the reader that is a person using different tools. This module owns everything the document declares for readers that are not people at all: search crawlers, link-unfurling bots, app-store scrapers, translation and locale negotiation. A page can be fully accessible and still be invisible to search, misrepresented when shared, or silently `noindex`ed in production — that is this module's entire scope, and none of it needs a running browser to check, because every signal here is a literal tag, header, or file.

## Per-page metadata

- [ ] `<title>` and meta description present on every route — `search_code` the templating layer (`generateMetadata`, `<Head>`, a layout's `<title>` block, or the SSG frontmatter convention) for whether these are set at all, and whether a templated route (`/product/[id]`) derives them from the record's own data or falls back to one hardcoded string for every instance.
- [ ] Title and description are unique per route, not merely capable of being unique — Read the metadata-generating function itself (`generateMetadata`, the `<Head>` component, or the frontmatter loader) and confirm the strings are built from the route's own params or data record, not returned as one constant reused for every match of that route pattern. Google rewrites both fields against query intent at serve time — independent studies put meta-description rewrites at roughly 60–75% — so the audit's job is confirming these are present, unique, and well-formed, never that a given string "will display" in the SERP; that is live behaviour, not a source-level fact.
- [ ] Canonical URL declared, and specifically absent on any page reachable at more than one path (with and without trailing slash, via a query-string variant, via both `www` and bare domain) — `search_code` for `rel="canonical"` or the framework's canonical helper.
- [ ] At most one `rel="canonical"` per page, and paginated routes (page 2 and beyond) never canonicalise back to page 1 — `search_code` for more than one canonical tag rendered on the same route (Google ignores all of them when it finds two) and read the pagination template's canonical logic specifically; a paginated list is not a duplicate of its first page, and canonicalising it away deindexes that page's content entirely.

## Social and crawler surface

- [ ] The Open Graph protocol's four *required* properties are present — `og:title`, `og:type`, `og:image`, `og:url` — `search_code` for the `og:` prefix in templates or a metadata helper. `og:description` is not part of the spec's required set but is universally expected by unfurlers; treat its absence as a real gap, just a different severity than a missing required property.
- [ ] `og:image` is an absolute URL — `search_code` its construction and confirm it is built against an absolute base URL (a full `https://` origin), not a relative path an unfurler cannot resolve; this one is a hard requirement, unlike the pair below. `og:image:width`/`og:image:height` are optional per spec, not required — their absence just forces the consuming platform to download the image before it can render a preview rather than sizing it immediately, so `search_code` for them and note the gap as a performance/reliability nit, not a spec violation. Where the image dimensions are computable, check they land near 1200×630 (1.91:1) — the size the major unfurlers (Facebook, LinkedIn, Slack, Discord, iMessage, WhatsApp) actually render well, distinct from and not stated by the spec itself.
- [ ] `search_code` for `twitter:card` and confirm its values are derived from the same source as the Open Graph tags, not a second, independently-maintained copy that has drifted. X falls back to `og:title`/`og:description`/`og:image` when `twitter:*` tags are absent entirely, so a page with complete Open Graph tags and no `twitter:*` tags at all is not itself a defect — only flag `twitter:*` values that are present and diverged from their Open Graph counterparts.
- [ ] A route with no custom Open Graph data falls back to a generic, route-appropriate default rather than silently inheriting the homepage's title and image — Read the metadata function's fallback branch and confirm it returns a default object distinct from the homepage's own metadata, not the same object reused for both.

## Indexing control

- [ ] `robots.txt` present — Read `public/robots.txt` (or the framework's `robots.ts`/`robots.js` generator) directly and list every `Disallow` rule; confirm each blocked path is deliberate (an admin path) rather than a rule that blocks the whole site by accident (`Disallow: /`).
- [ ] Per-page `noindex` directives agree with `robots.txt` — `search_code` for `noindex` in templates or a metadata helper, and check whether it is gated by an environment variable. **A `noindex` meta tag hardcoded into a shared layout, meant only for staging, is a silent production traffic outage** — nothing errors, nothing logs, the site simply stops appearing in search results. A hardcoded `noindex` reaching production is `read`-tier evidence, ceiling `High`; an env-gated one is `inferred`-tier for what the deployed value actually is, ceiling `Medium` — only a live check, outside this audit's static/declared-command scope, could confirm the deployed state and license `Critical`.
- [ ] No path carries both a `robots.txt` `Disallow` and a page-level `noindex`. Cross-reference the `Disallow` rule list from the check above against the `noindex` call sites found by `search_code` — a URL that is disallowed can never have its `noindex` tag read, because the crawler is blocked before it ever fetches the page. Per Google's own documentation, this makes the deindex attempt silently fail: the crawler never sees the instruction, and the URL can still surface in results (address and anchor text) if any external site links to it. The fix is one signal, not both — `noindex` a crawlable page, or `Disallow` a page you accept may still appear by URL alone, never both on the same path.
- [ ] Sitemap generation exists — `search_code` for a sitemap route or build-time generator — and `robots.txt` actually references it. A generated sitemap nothing links to is unreachable by any crawler that respects the standard discovery path. Weigh this against the site's actual shape first: Google's own guidance is that a well-linked site is discoverable by ordinary crawling without a sitemap at all, and a sitemap earns its keep specifically on a large site, a new site with few inbound links, or one carrying rich media (video, images) or News content — read the route count and check for those conditions before treating a missing sitemap as a finding on a small, densely cross-linked project.
- [ ] Sitemap entries match the route table. For a committed static `sitemap.xml`, diff its `<url>` entries against the route definitions found by `search_code`/`repo_map`; for a build-time generator (`sitemap.ts`, `next-sitemap` config), read the generator's route source and confirm it enumerates the app's actual route set rather than a hand-maintained list kept alongside it. These are two different failure modes — say which one you checked.

## Structured data and locale

- [ ] JSON-LD or microdata structured data present where the content type calls for it (product, article, FAQ, breadcrumb) — `search_code` for `application/ld+json` and confirm the fields it declares (price, availability, author, date) match what the page actually renders. Mismatched structured data is worse than none — it is the kind of thing that gets a listing penalised, not ignored. Schema markup is an eligibility signal for a rich result, never a ranking signal — Google still decides whether to render it, so do not describe present-and-correct structured data as something that "improves ranking."
- [ ] No structured data type the project emits is one Google has stopped consuming. `search_code` the `@type` values inside each `application/ld+json` block and check against the current retirement list — `FAQPage` (rich-result support removed May 2026), and `Course Info`, `ClaimReview`, `Estimated Salary`, `LearningVideo`, `SpecialAnnouncement`, and `VehicleListing` (removed June 2025; `Book Actions` was deprecated alongside these but Google reinstated it in November 2025 — do not flag it). A hit is not broken code — it still validates and runs — but it is dead investment: nothing on the results page consumes its output any more.
- [ ] `search_code` for `<html lang=` and confirm the value is bound to a locale variable or route param, not a hardcoded string literal (`lang="en"`) that would be wrong for every non-default locale served.
- [ ] `search_code` for `hreflang` and read the loop or map that generates the tags; confirm it iterates the full locale list — including a self-reference to the current locale and one `x-default` entry, used once per cluster for the fallback page, not per locale — rather than emitting a single hardcoded alternate. Cross-reference `i18n.md` for the locale set itself; this module only checks that the linking logic is complete.
- [ ] `hreflang` is reciprocal. Read the tag-generation logic and confirm every locale variant links to every other variant *and to itself* — a page that declares alternates but is not linked back by them is, by SEO-tooling consensus (Google itself lists it as one common mistake among several, unranked), the single most common `hreflang` implementation error. Also check the locale codes themselves against a real list (`en-GB` not `en-UK`, `pt-BR` not `pt-BZ`, hyphens not underscores) — malformed codes are not rejected with an error, they are silently ignored, so a typo here fails exactly like the tag being absent.

## Identity and stability

- [ ] `search_code` for `<link rel="icon"` and a `manifest.json`/`manifest.webmanifest` file, and confirm the manifest's icon set is complete where the project supports "add to home screen."
- [ ] Redirect and trailing-slash policy applied consistently — `search_code` the framework's `trailingSlash` setting (or equivalent redirect middleware) and confirm internal links match it; a mismatch means every internal link either triggers an extra redirect hop or a duplicate-content path search engines will flag.
- [ ] A "soft 404" — a not-found page that renders correctly but returns HTTP 200 — `search_code` the not-found handler and confirm it sets the actual status code, not just the visible content. This is the standard failure mode of client-side routing in an SPA: the server serves the shell successfully (200) and only the client-side router decides, after the fact, to render a "not found" view — the status line never reflects it. Where the route is SSR- or edge-rendered, confirm the handler returns a real non-200 status directly; where it is a pure client-side fallback with no server-side hook, check for the accepted mitigation instead — a JS redirect to a path the server does 404 on, or an injected `noindex` — and flag it if neither exists. A soft 404 is invisible to monitoring and, since crawlers classify it only after executing the page's JavaScript and inspecting the rendered DOM, it is invisible to a source read alone on any route where that JavaScript's actual runtime behaviour was not itself verified.
- [ ] URL structure changes leave redirects behind — cross-reference `versioning-compatibility.md` for any route renamed or restructured, then Read the redirect config or middleware (`next.config` `redirects()`, `vercel.json`, nginx rules) for an entry covering the old path pattern. An indexed URL with no matching redirect entry loses its accumulated search ranking with no way to recover it under the new path.

## Out of static reach

- Whether Google keeps a checked title or description as-written, or rewrites it against query intent — Google reports rewriting the majority of meta descriptions and any title it judges mismatched or oversized; a source read can only confirm the string is present, unique, and well-formed, never that it is what a searcher will actually see.
- How a shared link actually renders inside Slack, iMessage, WhatsApp, or X — each platform's unfurler has its own quirks and caching behaviour that only a live share can reveal.
- Actual search engine indexing status and ranking — `robots.txt` and meta tags state intent; whether a crawler honoured it requires the engine's own tools.
- Whether HTTP responses actually match the source-level claims verified above — a redirect entry proven to exist in config, or a status-code branch read in the not-found handler, still needs a live request to confirm the server issues `301`/`404` as written rather than something a proxy or CDN rewrites in front of it.
- Whether a page's rendered `<title>`, description, or `lang` value in the browser DOM matches what the source-level generator returns — a runtime bug downstream of correct source (a stale cache, a stale build) is invisible to a source read.
- Whether the sitemap's `lastmod` values are accurate, or whether a committed static sitemap was actually regenerated after the most recent route change the diff checked against.
- Rendered performance of any of the above on a client-side-rendered route where metadata is injected after first paint — some crawlers execute JavaScript, some do not, and this module cannot tell you which matters for a given page without knowing the target platform.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | HTTP status actually issued (`301`/`404`) versus what config or a status-code branch claims | High |
| `final-state.md` | Rendered `<title>`, description, or `lang` in the DOM after hydration, versus what the source-level generator returns | High |
| `final-state.md` | Open Graph tags as rendered in the DOM after hydration, versus declared values | Medium |
| `final-state.md` | Canonical URL as rendered after hydration, and that only one is present | High |

## Severity guidance

| Situation | Severity |
|---|---|
| `noindex` hardcoded into a shared layout/route reaching production | High |
| `noindex` gated by an environment variable, production value unconfirmed | Medium |
| Page `Disallow`ed in `robots.txt` while also carrying `noindex` — the noindex is never read | High |
| No canonical URL on a page reachable at multiple paths | High |
| Multiple `rel="canonical"` tags on one page, or a paginated page canonicalising to page 1 | High |
| URL structure changed with no redirect from the old path | High |
| Soft 404 returning HTTP 200 | High |
| Structured data fields contradicting the visible content | Medium |
| Missing or non-reciprocal `hreflang` on a multi-locale site | Medium |
| Open Graph image relative, or `og:title`/`og:type`/`og:image`/`og:url` missing | Medium |
| Sitemap missing on a large or poorly-linked site, or present but not referenced from `robots.txt`, or stale | Medium |
| Generic title/description reused across templated routes | Medium |
| Missing favicon or incomplete app manifest | Low |
| Structured data emitting a type Google no longer consumes (dead investment, not breakage) | Low |
| `og:image:width`/`og:image:height` absent (forces a synchronous fetch, not a spec violation) | Low |
| Twitter card duplicating Open Graph with drifted values | Low |
