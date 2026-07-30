# Security

Gate: auth, external input, or a network boundary was detected.

**Scope discipline.** This module finds and reports defects in the audited codebase. It does not write exploits, and it does not produce working attack payloads. A finding names the vulnerable line, the class of attack, and the fix.

Trace every input from where it enters to where it is used. `find_callees` from the entry point, or `trace_path` from the handler to the sink. An input that reaches a sink without passing validation is the finding.

## Injection sinks

Enumerate the sinks, then check what reaches each one:

- [ ] **Query** — any query built by concatenation or interpolation from external input. Parameterised or nothing. `Critical`.
- [ ] **Shell** — `exec`, `spawn` with a shell, or a command string built from input. Prefer argument arrays with no shell.
- [ ] **Filesystem** — a path built from input. Check for `..` traversal and absolute-path override; the fix is resolve-then-verify-inside-root, not string filtering.
- [ ] **Code** — `eval`, `new Function`, dynamic `require`/`import` of an input-derived name, deserialisation of untrusted data.
- [ ] **Template/markup** — unescaped interpolation into HTML, `innerHTML`, `dangerouslySetInnerHTML`.
- [ ] **Model prompt** — untrusted text concatenated into instructions; see `abuse.md` and `ai.md`.

## AuthN

- [ ] Credential comparison is constant-time. `search_code` for `===` against a token or secret.
- [ ] Passwords are hashed with a slow, salted algorithm — never a plain digest, never encrypted, never stored raw.
- [ ] Sessions and tokens expire, and expiry is checked with the correct comparison. An off-by-one on `<` vs `<=` at an expiry boundary is a real defect.
- [ ] Tokens are validated for signature, issuer, audience, and expiry — not merely decoded.
- [ ] Logout invalidates server-side, not only client-side.

## AuthZ

- [ ] Every protected operation checks authorisation, and the check is on the server. `find_callers` on the authorisation helper, then compare against the full list of protected handlers — the gap is the finding.
- [ ] Authorisation is checked against the *resource*, not only the *route*. Being logged in is not permission to read record 42.
- [ ] No object reference from the client is trusted as ownership proof.
- [ ] Privilege escalation paths: can a user set their own role, quota, or flags through a mass-assigned update?
- [ ] Default is deny. A new endpoint added tomorrow should be closed unless opened.

## Secrets

- [ ] No secret in source, config committed to the repo, test fixture, or log line. `search_code` for `secret`, `password`, `token`, `api_key`, `private_key`, `Bearer`.
- [ ] No secret in an error message, stack trace, or debug output.
- [ ] Secrets come from the environment or a secret manager, and absence fails loudly at startup.
- [ ] Check git history if a secret is found in the working tree — removal from HEAD does not remove it from history. Report the need for rotation.

## Transport and headers

- [ ] TLS enforced; no plaintext transport for credentials or user data. No disabled certificate verification — `search_code` for `rejectUnauthorized: false` and equivalents.
- [ ] CORS is not permissive-with-credentials. A wildcard origin plus credentials is `High`.
- [ ] Cookies are `HttpOnly`, `Secure`, and have an appropriate `SameSite`.
- [ ] State-changing requests are protected against cross-site forgery where cookie auth is used.

## Information disclosure

- [ ] No stack trace, internal path, dependency version, or query text reaches a client. Cross-reference `failure.md`.
- [ ] Error messages do not distinguish "no such user" from "wrong password".
- [ ] Directory listing, source maps, and debug endpoints are disabled in production.
- [ ] Logs do not contain credentials, tokens, or personal data — cross-reference `privacy.md`.

## Dependencies

- [ ] Known-vulnerable dependencies. Report the advisory, not a guess. Cross-reference `dependencies-licensing.md`.
- [ ] Lockfile present and committed, so builds are reproducible.

## Severity guidance

| Situation | Severity |
|---|---|
| Injection sink reachable from unvalidated external input | Critical |
| Missing authorisation on a protected operation | Critical |
| Secret committed to the repository | Critical |
| Password stored unhashed or reversibly | Critical |
| Certificate verification disabled | High |
| Authorisation checked on route but not on resource | High |
| Wildcard CORS with credentials | High |
| Non-constant-time secret comparison | Medium |
| Missing cookie security attributes | Medium |
| Internal detail disclosed in an error | Medium |
