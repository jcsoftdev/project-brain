# Flow Integrity

Does each user-visible flow actually complete? Reachability asks whether code runs at all; this module asks whether a flow that runs ever *finishes*. Half-wired features pass every type check and every unit test — they only fail a user.

Trace each flow end to end with `trace_path` from the entry point (button, command, route, event) to its terminal effect (write, response, navigation, render). A flow with no proven terminal effect is the finding.

## Flow selection

- [ ] Before walking every discovered flow, `Read` product.md/discovery notes (or `get_architecture`/`repo_map` for entry points where no product doc exists) to identify the flows with the highest business impact — signup, auth, checkout/payment, and the product's core write action. `trace_path` those first and fully; flows outside that set are recorded as sampled, not silently omitted, if time-boxing forces a cut — practitioner heuristic, no source found for a documented business-impact prioritisation rule.

## Orphan UI

- [ ] Handlers wired to nothing — `search_code` for the literal patterns `onClick={() => {}}`, `onSubmit={() => {}}`, `href="#"`, and `TODO`/`FIXME` co-located with a handler name. Read the surrounding component before reporting, to rule out a deliberately no-op control (a disabled preview, a placeholder in an unreleased section).
- [ ] Buttons and menu items whose handler navigates to a route that does not exist, or opens a modal never rendered — `search_code` the route or path string passed to the navigation call, then `find_symbol` for a matching route definition; for a modal, `find_callers` on its render to confirm something actually mounts it.
- [ ] Forms whose submit handler validates and then returns without calling anything — `find_callees` on the submit handler. A call list that ends at the validator with no request or dispatch call after it is the finding.
- [ ] Controls disabled unconditionally, or rendered behind a condition that is never true — `search_code` for `disabled={true}` or `disabled` as a bare boolean literal, and read the guarding condition for a constant that can never evaluate true.
- [ ] Keyboard shortcuts and context-menu entries registered but bound to no action — `search_code` the shortcut-registration call (`useHotkeys`, `addEventListener('keydown'`, a context-menu config array), then `find_callees` on the bound callback.

## Flows with no terminal state

For every flow the user can start, confirm it can end:

- [ ] **Submit into the void** — `trace_path` from the request-firing call to any consumer of its response or promise. No path found is the finding. Rule out a request whose own documentation or naming marks it as intentionally fire-and-forget (an analytics beacon, a best-effort "mark as read" ping) before flagging.
- [ ] **Success with no feedback** — `find_callees` on the success branch (`.then`, `onSuccess`); no call to a toast, notification, or state-update function after the write means success is silent. The user retries; now you have a duplicate-write bug — idempotency keys are the documented fix Stripe ships for exactly this risk, letting a client "safely repeat the request without risk of creating a second object or performing the update twice" (Stripe, official API reference documentation, current, https://docs.stripe.com/api/idempotent_requests).
- [ ] `search_code` the request call behind a create-style mutation (a "Submit"/"Pay"/"Create" action, not a `PUT`/`DELETE`) for an idempotency-key or client-generated request-id parameter attached to the call. Where none exists, `find_callers` on the submit handler to confirm no disable-on-submit or debounce guard exists either — a network retry or a fast double-click then creates two records with no server-side mechanism to collapse them (Stripe, official API reference documentation, current, https://docs.stripe.com/api/idempotent_requests). Refuted if a server-side unique constraint on a natural key (an email, an order reference, a slug) collapses the duplicate write into one row regardless of the missing idempotency key — `find_symbol` the target table/model's constraints before flagging.
- [ ] **Unhandled error path** — `search_code` for `catch {}`, `.catch(() => {})`, and a `catch` block that only logs — an error state the UI cannot render. This is CWE-1069 Empty Exception Block: "an invokable code block contains an exception handling block that does not contain any code," which "can prevent the product from running reliably" (MITRE, CWE, current, https://cwe.mitre.org/data/definitions/1069.html).
- [ ] **No cancel / no back** — `Read` the multi-step flow's component tree for a cancel or back handler; its absence alongside a wizard/stepper component is the finding.
- [ ] **No timeout** — `search_code` the request call (`fetch(`, the HTTP client instance) and confirm a timeout or abort-controller is attached. None found means the UI can hang in loading indefinitely.
- [ ] **Missing confirmation on destructive actions** — `search_code` the delete/reset/overwrite handler, then `find_callees` to confirm a confirmation-dialog component is invoked *before* the mutating call, not merely rendered somewhere else in the tree.

## Half-wired features

Each of these is a pair where only one half exists. Prove the counterpart with the paired calls below, not by eyeballing directory names. A feature-flag key read in code with no live declaration is `feature-flags.md`'s own headline check ("Reads with no declaration — the most damaging defect here") — cross-reference it there instead of re-reporting it here; it scores `High` at `read`, escalating to `Critical` when `find_callers`/`trace_path` traces the mis-keyed call site to an auth/paywall/billing decision.

| One half exists | Missing counterpart | Probe | Typical severity |
|---|---|---|---|
| Backend endpoint | No UI or client calls it | `search_code` the route path in client code; `find_callers` on the handler | Medium |
| UI component | No backend to serve it | `find_callees` on the component's submit/fetch call; `search_code` the target path server-side | High |
| Migration creates a column | No code ever reads or writes it | `search_code` the column name across query and model code | Low → Medium |
| Code reads a column | No migration creates it | `search_code` the column name across every migration file; `find_callers` on the reading code to confirm it sits on a live, reachable path | High → Critical (traced) |
| Event emitted | No listener subscribed | `find_callers` on the emit call; `search_code` the event name in subscription code | Medium |
| Listener subscribed | No emitter | `search_code` the event name for any `.emit(`/`dispatch(` call site | Low |
| Job enqueued | No worker consumes that queue | `search_code` the queue name in worker registration | High |
| Worker consuming a queue | Nothing ever enqueues to it | `search_code` the queue name at every enqueue call site | Medium |
| Config option accepted | No code branches on it | `find_callers` on the config field access | Low |
| Webhook receiver | Registered but exempted from nothing — `search_code` the CSRF/session-auth middleware registration (`protect_from_forgery`, `csrf`, a global `app.use` auth guard) and `Read` the route mount order to confirm the webhook path is explicitly exempted; Stripe warns CSRF protection "might also prevent your site from processing legitimate events." Provider behavior on a rejected delivery differs by provider and is checked before assuming either: Stripe retries a failed delivery for up to three days (Stripe, official vendor documentation, current, https://docs.stripe.com/webhooks), while GitHub records a 4xx as a failed delivery within a 10-second response window and does not auto-redeliver it (GitHub, official product documentation, current, https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks; GitHub, official product documentation, current, https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries). No registration declared anywhere in-repo (deploy config, IaC, admin notes) is a coverage-gap candidate, not a proven finding — this module can prove the receiver code exists, not that the provider is configured to call it; see Out of static reach. | `search_code` the webhook URL/path in provider setup, deploy config, or admin notes | High |

## The loading / empty / error triad

Every view that fetches data needs three states beyond the happy path. Missing any one is a real defect, not polish.

- [ ] **Loading** — `search_code` the fetch/query hook usage (`useQuery`, `isLoading`) in the view and read the render for a loading branch; its absence means the screen sits blank while the request is in flight.
- [ ] **Empty** — `search_code` the render of the list/collection and confirm a zero-length branch exists before the item map; a bare `.map()` with no guard renders a broken-looking blank list or crashes on `data[0]`.
- [ ] **Error** — `search_code` the same hook's error state (`isError`, `error`) and confirm it renders an actionable message with a retry where retrying is meaningful, not just a console log.
- [ ] The three states are mutually exclusive and reachable — `Read` the conditional rendering order; overlapping conditions (an `isLoading` check that doesn't exclude `isEmpty`) let two states render at once.

## Cross-cutting

- [ ] Optimistic updates have a rollback path when the request fails — `find_callees` on the optimistic-update function; the error branch needs a rollback/revert call, not just a log. The supported pattern is `onMutate` snapshotting the previous cache value and returning it as context, with `onError` using that snapshot to restore state; a plain refetch is a distinct strategy from rollback, not a substitute for one (TanStack core team, official framework documentation, current, https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates).
- [ ] `find_callees` on the webhook receiver's handler function, before its response is sent. If the callee chain runs a database write, an external API call, or other non-trivial work synchronously with no queue/job dispatch (`enqueue`, `.delay(`, a job-queue `.add(`) in between, the handler risks missing the provider's response-time window; the provider marks the delivery failed and either drops it or retries into a system that already partially processed it — GitHub requires a response "within 10 seconds" and records a 4xx/5xx as a failure (GitHub, official product documentation, current, https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks), and Stripe's own best practice is to "handle events asynchronously" since synchronous processing "might encounter scalability issues" (Stripe, official vendor documentation, current, https://docs.stripe.com/webhooks). Refuted if the callee chain is trivially fast (a single indexed upsert, no outbound call), or the platform queues every request transparently at the infrastructure layer (a serverless function fronted by a managed queue).
- [ ] Multi-step flows survive a page reload, or explicitly warn before losing progress — `search_code` for persisted step state (`sessionStorage`, `localStorage`, a URL param) or a `beforeunload` handler. Absence of both is the finding.
- [ ] Every flow that writes has a corresponding way to read the result back — `search_code` a GET/query counterpart to each mutating endpoint or dispatch.
- [ ] Authenticated flows handle session expiry mid-flow rather than failing at the final step — `search_code` for a 401/expired-session interceptor and confirm it is wired into the same client used by long-running flows, not only the initial page load.
- [ ] `Read` a webhook handler that advances a stored state machine (e.g. subscription onboarding, order fulfillment) per event type. If the transition logic trusts the incoming event's type alone to decide the next state, with no `find_callees`-provable reconciliation call back to the source of truth (a GET/query re-fetch of current state before applying the transition), an out-of-order delivery can move the state machine backwards or skip a step — Stripe states plainly it "doesn't guarantee the delivery of events in the order that they're generated" (Stripe, official vendor documentation, current, https://docs.stripe.com/webhooks). Refuted if the handler already re-fetches current state from the source of truth before applying each event — check `find_callees` for that reconciliation call before flagging.

## Out of static reach

- Whether the loading/error UI actually renders correctly at runtime — this module proves the branch exists, not that it looks right or fires in time.
- Timing-dependent races between an optimistic update and the server's real response under real network latency.
- Whether a confirmation dialog is easy to dismiss accidentally, or whether users read it before clicking through.
- Session-expiry handling that depends on server-side token lifetimes not visible from source.
- Whether an event with no in-repo listener is consumed by a downstream service, browser extension, or webhook subscriber outside this repo.
- Whether this webhook is registered with the provider — this module can prove the receiver code exists, not that the provider is configured to call it.
- Whether events for this flow are ever delivered out of order in production — this module reads the handler's ordering assumption, not a live race.
- Whether a missing idempotency guard produces a real duplicate write in production — this module proves the guard is absent, not that duplication occurred.
- Whether an orphaned-looking flag is safe to archive — this module sees the code side, not the flag provider's full consumer list.

## What browser observation closes

Applies only when `browser.md` ran; findings here are `observed` and cite the bundle path with a line or step number.

| Artefact | Gap it closes | Observed instance earns |
|---|---|---|
| `steps.md` | Whether the loading/error UI actually renders correctly at runtime, versus merely proving the branch exists in source | High |
| `network.jsonl` | Timing-dependent race between an optimistic update and the server's real response — bounded to the single observed timing, not eliminated as a possibility | Medium |
| `steps.md` | Orphan control confirmed: a control clicked during a walked flow produced no request and no DOM/state change | High |
| `routes.md`, `steps.md` | Orphan navigation target confirmed at runtime — a control's click target never appears among `routes.md`'s routes discovered, and the click itself produces no URL change / a 404 render. Refuted if the target is an intentionally excluded dev-only or feature-flagged route, named as such | High |
| `network.jsonl`, `steps.md`/`final-state.md` | Submit-into-the-void confirmed at runtime — the write request fires with no subsequent read-back request in the same flow, and no state change after. Refuted if the request is named/documented as fire-and-forget (analytics beacon, best-effort ping) | High |
| `steps.md`, `screenshots/`, `network.jsonl` | Missing confirmation on a destructive action, observed — a delete/reset/overwrite control's click is immediately followed by the mutating call, with no confirmation-dialog step or screenshot recorded in between. Refuted if a confirmation step exists elsewhere in the flow and this walk simply skipped it — re-walk before flagging | High |
| `network.jsonl`, `steps.md`/`screenshots/` | Hang with no timeout confirmed — a request pending past a generous threshold with a stuck loading indicator and no timeout/abort UI. Refuted if the operation is legitimately long-running and the UI's own copy says so (a report export, a batch job) — bounded to this one observed timing | Medium |

## Reporting

Report each broken flow as a path, not a symptom: `entry point (file:line) → … → dead end (file:line)`. State which step is missing and what the user experiences when they hit it. That is the difference between "this looks unfinished" and a finding someone can fix.

## Severity guidance

| Situation | Severity |
|---|---|
| Client calls an endpoint that does not exist, established by `search_code` for the route path server-side | High |
| Code reads a column no migration creates, `find_callers`-traced to a live, reachable call site | Critical |
| Code reads a column no migration creates, established only by the migration-file `search_code` | High |
| UI component with no backend to serve it | High |
| Webhook receiver route not backed by any registration declared in-repo (deploy config, IaC, admin notes) — coverage gap, confirm against the provider dashboard directly | High |
| Job enqueued with no worker consuming the queue | High |
| Unhandled error path swallowed silently | High |
| Success with no feedback, risking a duplicate-write retry | Medium |
| Missing loading, empty, or error state on a data view | Medium |
| Handler wired to nothing (orphan UI) | Medium |
| Backend endpoint with no caller | Medium |
| Optimistic update with no rollback path | Medium |
| Webhook receiver route not exempted from CSRF/session-auth middleware | High |
| Webhook handler runs heavy processing synchronously with no async dispatch before the response | High |
| Non-idempotent create action with no idempotency key or disable-on-submit guard | Medium |
| Webhook-driven state machine trusts event order with no reconciliation call to the source of truth | Medium |
| Config option accepted but nothing branches on it | Low |
| Listener subscribed with no emitter | Low |
