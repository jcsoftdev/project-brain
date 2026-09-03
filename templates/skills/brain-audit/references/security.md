# Security

Gate: auth, external input, or a network boundary was detected.

**Scope discipline.** This module finds and reports defects in the audited codebase. It does not write exploits, and it does not produce working attack payloads. A finding names the vulnerable line, the class of attack, and the fix.

**This is the module where an invented finding does the most damage.** A false Critical here does not sit quietly in a backlog — it sends someone onto an emergency rotation for nothing, and the second cost is worse than the first: it trains that team to discount the next alert this skill raises, including the real one. Every rule-out below is not optional colour, it is the difference between a finding and an incident. If a check cannot be traced to its origin, it is not reported at this severity — see the Evidence Contract in `SKILL.md`.

Trace every input from where it enters to where it is used. `find_callees` from the entry point, or `trace_path` from the handler to the sink. An input that reaches a sink without passing validation is the finding.

## Injection sinks

Enumerate the sinks, then check what reaches each one. For every hit, the rule-out is the same shape: `trace_path` (or `find_callers` walked backward one hop at a time) from the sink to the value's origin. A value that terminates at a literal, an internal config object, or a value already validated upstream is not a finding — an invented finding at Critical is a full incident response for nothing, so confirm the traced origin is unvalidated external input before reporting anything.

- [ ] **Query** — `search_code` for string concatenation or template interpolation feeding a query call (`+ req.`, `` `${...}` `` next to a query function, `.raw(`, `f"SELECT`). Trace the interpolated value back with `trace_path`; parameterised or nothing. CWE-89, #2 in the 2025 CWE Top 25. `Critical`.
- [ ] **Shell** — `search_code` for `exec(`, `spawn(` with `shell: true`, `os.system(`, `subprocess.` with `shell=True`, or backtick/string command construction. Trace the command string's origin; prefer argument arrays with no shell. CWE-78/CWE-77 (OS command injection, #9/#23 in the 2025 CWE Top 25).
- [ ] **Filesystem** — `search_code` for `path.join(`/`os.path.join(` fed by a request parameter, or raw string path building. Read the resolved-path handling for `..` traversal and absolute-path override; the fix is resolve-then-verify-inside-root, not string filtering. CWE-22 Path Traversal, #6 in the 2025 CWE Top 25 (CVE-2021-41773 in Apache HTTP Server 2.4.49 is a canonical instance — a path-normalisation regression that, combined with enabled CGI, reached remote code execution).
- [ ] **Code** — `search_code` for `eval(`, `new Function(`, dynamic `require(`/`import(` of a computed name, `pickle.loads`, `yaml.load` without `SafeLoader`, or other deserialisation of untrusted data. Trace the argument to its source. CWE-94 Code Injection (#10) or CWE-502 Deserialization of Untrusted Data (#15) in the 2025 CWE Top 25 — cite whichever fits the sink.
- [ ] **Template/markup** — `search_code` for `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, or a template engine's raw/unescaped filter. Trace the value; a hit rendering only static or already-sanitised content is not the finding. CWE-79 Cross-Site Scripting, #1 in the 2025 CWE Top 25.
- [ ] **Model prompt** — `search_code` for string concatenation into a prompt or messages array. Trace the concatenated text to confirm it is untrusted user content, not a fixed system instruction; see `abuse.md` and `ai.md`.
- [ ] **Outbound request (SSRF)** — `search_code` for `fetch(`, `axios.get(`, `requests.get(`/`urllib.request`, `http.get(`/`net/http` fed by a request-derived value (a webhook-target field, an "import from URL"/avatar-by-URL feature, a PDF-render-from-URL endpoint). Trace the URL's origin with `trace_path`; a value checked against a destination allowlist before the request executes is not the finding. CWE-918 Server-Side Request Forgery, #22 in the 2025 CWE Top 25.
- [ ] **Redirect** — `search_code` for `res.redirect(`/`window.location =`/a `Location:` response header fed by a query or body parameter (`?returnUrl=`, `?next=`, `?redirect_uri=` outside a fixed OAuth callback list). Trace the parameter's origin with `trace_path`; a target checked against an allowlist or resolved through a fixed id-to-URL mapping is not the finding. CWE-601 URL Redirection to Untrusted Site.

## AuthN

ASVS 5.0 §V6 (Authentication) and §V7 (Session Management) cover this section.

- [ ] Credential comparison is constant-time. `search_code` for `===`, `==`, or `.equals(` comparing a token, secret, or hash — read the call site; a comparison against a non-secret value (a public id, a CSRF token already bound to session) does not qualify. CWE-208 Observable Timing Discrepancy.
- [ ] Passwords are hashed with a slow, salted algorithm. `find_symbol`/`search_code` the registration or password-set handler and read what it calls before persisting — `bcrypt`/`argon2`/`scrypt` is correct, `md5`/`sha256`/plain storage is the finding. This is `High` at `read`; `find_callees` on the handler between receiving the password and the persist call, confirming no hash/bcrypt/argon2/scrypt call intervenes, promotes it to `traced`, and `Critical`.
- [ ] Sessions and tokens expire (ASVS 5.0 §V7.3.1 inactivity timeout and §V7.3.2 absolute session lifetime), and expiry is checked with the correct comparison. `find_symbol` the verify function and read the comparison operator literally — an off-by-one on `<` vs `<=` at the expiry boundary is a real defect, not a style nit.
- [ ] Tokens are validated for signature, issuer, audience, and expiry. Read the verify call's options argument directly — a call that only decodes (`jwt.decode` with verification disabled, or no `verify()` at all) is the finding regardless of what happens after.
- [ ] Logout invalidates server-side. `find_symbol` the logout handler, then `find_callees` — a handler that only clears a client-side cookie or local storage entry, with no server-side session/token revocation call, is the finding. ASVS 5.0 §V7.4.1: termination must "disallow any further use of the session" — client-side cookie deletion alone is explicitly insufficient. Rule out a stateless-token design with no server-side session store at all and a short token TTL — confirm which applies before flagging.

## AuthZ

ASVS 5.0 §V8 (Authorization) covers this section. The specific defect below — a handler trusting a client-supplied resource id as ownership proof — is **Broken Object Level Authorization**, OWASP API Security Top 10:2023 API1 (BOLA), CWE-639 Authorization Bypass Through User-Controlled Key, #24 in the 2025 CWE Top 25.

- [ ] Every protected operation checks authorisation, and the check is on the server. `find_callers` on the authorisation helper, then compare against the full list of protected handlers from `get_architecture`/route discovery — the gap between the two lists is the finding. CWE-862 Missing Authorization, #4 in the 2025 CWE Top 25.
- [ ] Authorisation is checked against the *resource*, not only the *route*. `trace_path` from the handler to the query that loads the record and confirm the caller's identity is compared against an ownership or ACL field before the read/write executes — a handler that only checks "is authenticated" and then loads by the id in the URL is the finding (BOLA, see above).
- [ ] No object reference from the client is trusted as ownership proof — `trace_path` the same handler-to-query path as above; the id in the request is data, not a credential.
- [ ] A caught exception or an unmatched branch in an authorisation check does not fail open. Read the authorisation helper's error handling directly — a `try/catch` around the permission check that falls through to "allow" on any exception, or a `switch`/`if` chain with no explicit deny in the default branch, is the finding. This is OWASP Top 10:2025 A10 (Mishandling of Exceptional Conditions), new for the 2025 edition.
- [ ] Mass assignment: `search_code` for `...req.body` spread into an update call, or an ORM `.update(req.body)`/`.save(req.body)` with no field allowlist. A hit with an explicit `pick`/DTO/schema validation between the request and the update is not the finding. OWASP API Security Top 10:2023 API3 (Broken Object Property Level Authorization / BOPLA).
- [ ] Default is deny. `search_code` the router/framework's default-route configuration for an unmatched or newly added route — a default-allow framework configuration is itself a finding even with no missing check found yet.

## Secrets

- [ ] `search_code` for `secret`, `password`, `token`, `api_key`, `private_key`, `Bearer` as literal string assignments (OWASP Secrets Management Cheat Sheet). This is the highest false-positive check in the whole skill — read every hit before reporting. A hit assigning a hardcoded literal (`"sk-...")`, `"changeme"` used as a real default, a real-looking key in a fixture reused outside tests) is the finding; a hit reading from `process.env`, a config object backed by env, or a secret-manager client call is not. This is `High` at `read`; `find_callers` on the constant the literal is assigned to (or `trace_path` from its module to the client constructor) showing it reaches a live client/service constructor promotes it to `traced`, and `Critical`.
- [ ] No secret in an error message, stack trace, or debug output — Read the logging/error-serialisation call sites found under Information disclosure below for a secret-bearing field, don't infer it.
- [ ] Secrets come from the environment or a secret manager, and absence fails loudly at startup. `search_code` the config-loading module for a fallback default on a secret-shaped key — a silent fallback (`|| 'default-secret'`) is the finding, not the absence of one. Application/service secrets should also carry an expiry or rotation mechanism, not just a source — read the secret-manager client call for a TTL/rotation parameter; its total absence on a long-lived service credential is `read`-tier evidence for a finding (OWASP Secrets Management Cheat Sheet's rotation-cadence guidance; this does not apply to user passwords, where mandatory periodic rotation is now considered outdated guidance per NIST SP 800-63B — "verifiers SHOULD NOT require memorized secrets to be changed arbitrarily," only on evidence of compromise — do not flag its absence).
- [ ] If a secret is found in the working tree, `search_code` the same value across the tree to bound how far it spread, then hand the history question to `repo-history.md`'s pickaxe search (`git log -p -S'<pattern>'` is that module's probe, not this one's) — removal from `HEAD` does not remove it from history. **Rotation is required regardless of whether the check-in was reverted or the history was later rewritten** — per OWASP's Secrets Management Cheat Sheet, squashing/rewriting history addresses the commit trail, not the exposure: the secret was retrievable, so it is compromised, full stop. Proactive, exhaustive history scanning is owned by `repo-history.md`; this line stays reactive — do not expand history work here.

## Transport and headers

- [ ] TLS enforced; no plaintext transport for credentials or user data. `search_code` for `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False` (requests/httpx), or `InsecureSkipVerify: true` (Go) — each disables certificate verification outright and needs no further rule-out.
- [ ] CORS is not permissive-with-credentials. `search_code` for the CORS configuration and read it as one object — a wildcard origin (`*`) and `credentials: true` must be set on the *same* middleware instance to qualify; a wildcard on a public, unauthenticated endpoint with `credentials: false` elsewhere is not the finding. MDN: a wildcard `Access-Control-Allow-Origin` combined with `credentials: true` on the same response is the invalid, exploitable combination.
- [ ] Cookies are `HttpOnly`, `Secure`, and have an appropriate `SameSite`. `search_code` for the cookie-setting call (`res.cookie(`, `Set-Cookie`, `set_cookie(`) and read the options object directly rather than assuming defaults. IETF httpbis, *Cookies: HTTP State Management Mechanism*: `Secure` gates transmission to a secure channel, `HttpOnly` gates non-HTTP API access, and an absent/unrecognised `SameSite` value defaults to `Lax`-equivalent enforcement.
- [ ] `search_code` the server/middleware configuration (`helmet(`, a custom response-header middleware, framework security defaults) for `X-Frame-Options` or a Content-Security-Policy `frame-ancestors` directive on HTML-serving responses. No hit on either, on a page that is not an intentionally embeddable widget, is the finding. OWASP Clickjacking Defense Cheat Sheet recommends `X-Frame-Options: DENY`/`SAMEORIGIN` and CSP `frame-ancestors` on every HTML response unless framing is a designed feature.
- [ ] State-changing requests are protected against cross-site forgery where cookie auth is used. First confirm the auth mechanism: `search_code` for how the session is authenticated — a pure Bearer-token API with no cookie in the auth path does not need CSRF protection, and flagging its absence there is the false positive. Where cookie auth is confirmed, `search_code` for CSRF middleware/token verification and check it is wired into the state-changing routes, not just imported.

## Information disclosure

- [ ] No stack trace, internal path, dependency version, or query text reaches a client. `search_code` the central error handler for `err.stack`, `err.message`, or a caught error object serialised directly into the response body. OWASP Top 10:2025 A10 (Mishandling of Exceptional Conditions), CWE-209 Generation of Error Message Containing Sensitive Information. Cross-reference `failure.md`.
- [ ] Error messages do not distinguish "no such user" from "wrong password". Read the login and password-reset handlers directly and literally compare the status code and message text returned on each branch — they must be identical, not merely similar.
- [ ] Directory listing, source maps, and debug endpoints are disabled in production. `search_code` the production build/deploy config for `sourceMap: true`, `devtool:` set to a non-hidden value, or a static-file server with listing enabled.
- [ ] Logs do not contain credentials, tokens, or personal data. Read what is passed to the logger at the request-boundary middleware — a logged `req` or `req.headers` object without redaction is the finding; cross-reference `privacy.md`.

## Dependencies

- [ ] Known-vulnerable dependencies: cross-reference `dependencies-licensing.md` (`search_code` the CI pipeline for an `npm audit`/`pip-audit`/`osv-scanner` step) rather than duplicating that inventory here. Do not maintain a CVE list in this module — it goes stale the day it's written; live vulnerability status is unverifiable from source and belongs in Out of static reach.
- [ ] Lockfile present and committed — owned by `supply-chain.md` (`get_architecture` packageManager, then confirm the lockfile is tracked); reuse its finding, do not re-report.

## Out of static reach

- Whether a flagged dependency vulnerability is actually exploitable in this codebase's usage of it — that needs the vulnerable code path exercised, not just present.
- Live CVE/advisory status for any dependency — the manifest is a point-in-time read; advisories are published continuously. Closeable via `runtime.md` if the project declares an audit/scan command that CI already runs.
- Whether network-layer controls (WAF rules, firewall policy, a reverse proxy's own header stripping) already mitigate a code-level finding.
- Actual production TLS/certificate configuration, as opposed to what the code declares — the deployed reality can diverge from the repo; the certificate itself and the handshake that negotiated it stay out of reach regardless.
- Whether a secret found in git history or the current working tree has actually been rotated after the finding was reported — this module can only prove exposure, not remediation; the reactive line above stays here, proactive scanning is `repo-history.md`'s job.
- Whether a rate limit, lockout policy, or auth control holds up under real concurrent traffic — cross-reference `abuse.md` and `concurrency.md` for the structural checks; effectiveness under load is not something source can show.
- Whether a response header the code sets is the header a real client receives — a reverse proxy, CDN, or load balancer sitting in front of the app can strip or override a header the source code sets; without browser observation, source proves intent, not delivery.
- Whether an unvalidated outbound-request sink can actually reach a sensitive internal target (a cloud metadata endpoint, an internal admin panel) in production — that is a network-topology fact, not a code fact.
- Whether a found secret is still active versus already rotated/revoked at the provider — this module can prove exposure, never current validity; it cannot call the credential's own provider to check.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number. Never claim TLS handshake data or certificate validity from this bundle — `network.jsonl` shows only the request's scheme and response headers.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `network.jsonl` | Missing HSTS or CSP response headers, with a measurer present | High |
| `network.jsonl` | Cookie flags (`HttpOnly`/`Secure`/`SameSite`) on a real `Set-Cookie` response header | High |
| `network.jsonl` | Mixed content — an `http://` request made from an `https://` page | High |
| `network.jsonl` | Anti-clickjacking headers (`X-Frame-Options`, CSP `frame-ancestors`) on the primary HTML document response | High |
| `network.jsonl` | CORS preflight response exposes a wildcard origin with credentials allowed — `OPTIONS` response header pair on the same endpoint | High |
| `console.jsonl` | CSP violation reported by the browser itself | Info to Medium, scaled to what the violated directive protects |

## Severity guidance

| Situation | Severity |
|---|---|
| Injection sink reachable from unvalidated external input | Critical |
| Missing authorisation on a protected operation | Critical |
| Secret literal traced (`find_callers`) to a live client/service constructor, still committed | Critical |
| Secret committed to the repository (regardless of later history rewrite), reach not traced | High |
| Password unhashed, traced (`find_callees`) with no hash call between input and persistence | Critical |
| Password stored unhashed or reversibly, reach not traced | High |
| Authorisation check fails open on an unhandled exception | High |
| Certificate verification disabled | High |
| Authorisation checked on route but not on resource (BOLA) | High |
| Wildcard CORS with credentials | High |
| Non-constant-time secret comparison | Medium |
| Missing cookie security attributes | Medium |
| Internal detail disclosed in an error | Medium |
| Outbound request reaching an unvalidated destination (SSRF), traced to unvalidated external input | Critical |
| Redirect target traced (`trace_path`) to unvalidated client input, no allowlist | Medium |
| Missing anti-clickjacking headers on an HTML-serving response | Medium |
