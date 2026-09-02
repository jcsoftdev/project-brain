# Mobile

Native or cross-platform mobile concerns. Gate: a native mobile project was detected.

Mobile amplifies every defect the other modules find: the network is unreliable, the process can die at any moment, and the user cannot read a stack trace. Audit accordingly. The auditor cannot run a device or emulator — every check below establishes what the source commits to, and what only a running device could confirm is listed under `Out of static reach`.

## Lifecycle

- [ ] State survives backgrounding. `search_code` for the lifecycle hook (`onPause`, `applicationDidEnterBackground`, an `AppState` listener) and confirm state bound to a form field or a multi-step flow's progress — specifically, not any other in-memory value such as scroll position or an open toast — is written to a durable store (disk, `SharedPreferences`/`UserDefaults`, a persisted store) inside that hook, not only held in a view model.
- [ ] In-flight work is paused or cancelled on background, and resumed or abandoned deliberately on foreground. `find_callees` on the background/foreground lifecycle hooks for a cancellation or resume call on the in-flight request or task object.
- [ ] Deep links and cold starts reach the same state as in-app navigation. `trace_path` from the deep-link handler to the target screen's initialisation — a screen reachable only through a parent route that sets state the deep link skips is the finding.
- [ ] Rotation and configuration changes do not lose user input. `search_code` for the rotation/configuration-change callback and confirm form or input state is restored from a saved-instance-state mechanism rather than reset to defaults. Exclude screens locked to a single orientation (`android:screenOrientation="portrait"` or equivalent), where rotation cannot occur at all.

## Network reality

- [ ] Every request assumes it can fail, be slow, or arrive twice. `find_callees` on each network call site for a catch/error branch — a call with no error handling treats failure as impossible.
- [ ] Retries are bounded and backed off — owned by `failure.md` (`search_code` the retry wrapper around a network call and confirm a max-attempt count and backoff exist); reuse its finding, do not re-report. This module's own angle is the metered-connection cost consequence: an unbounded retry on a metered connection is a cost defect too — cross-reference `Cost`.
- [ ] Large payloads are paginated or streamed. `search_code` for a list-fetching call with no page/cursor parameter, against an endpoint the `API` module's inventory shows supports one.
- [ ] Uploads survive interruption, or explicitly restart. `find_callees` on the upload call site for a resume/checkpoint mechanism; its absence means any interruption restarts from zero with no stated fallback.

## Permissions

- [ ] Every permission requested is actually used. `search_code` the manifest/plist for each declared permission, then `find_callers` on the corresponding platform API to confirm a call site exists — an unused permission is a store-review risk and a trust cost.
- [ ] Denial is handled, including permanent denial, with a path forward rather than a dead end. `find_callees` on the permission-request call site for a denial branch, and a further branch for the "don't ask again"/permanently-denied state.
- [ ] Permissions are requested at the moment of need with context, not all at launch. `find_callers` on the permission-request call to confirm it fires from the feature that needs it, not from app-startup code.

## Storage and secrets

- [ ] Tokens and credentials use the platform keystore, never plain preferences or a local file. `search_code` for a token/credential-shaped variable name adjacent to a `SharedPreferences`/`UserDefaults`/plain-file write call, instead of `Keychain`/`Keystore`/`EncryptedSharedPreferences`; that is `High` at `read`. `trace_path` from the auth client/handler that produces the token to the plain-storage write call promotes the finding to `traced`, and `Critical`, by proving the value is genuinely a live credential rather than a similarly-named field.
- [ ] Cached user data is clearable, and logout actually clears it. `find_callees` on the logout handler for a call that clears the local cache/database; its absence means logged-out state still holds the previous user's data.
- [ ] Local database migrations exist and are tested against the previous version's schema. `search_code` the local-DB migration directory and confirm a version-bump path exists — cross-reference `database.md`'s migration checks for the fuller review.

## Platform integration

- [ ] Both platforms are covered wherever the code branches on OS. `search_code` for `Platform.OS`/`#if os(`/build-variant conditionals and confirm each branch has a corresponding implementation, not a fallthrough or a no-op on one side — cross-reference `flow-integrity.md`.
- [ ] Minimum OS version claimed by the manifest matches the APIs actually used. Read the manifest's `minSdkVersion`/`MinimumOSVersion`, then `search_code` for any API call whose documented minimum exceeds it.
- [ ] Safe areas, notches, and system bars are respected. `search_code` for `SafeAreaView`/`safeAreaInsets`/edge-to-edge handling on screens with content near the top or bottom edge; its absence on a full-bleed screen is the finding.
- [ ] Back-navigation follows platform convention, including hardware back. `search_code` for a hardware-back-button override (`onBackPressed`, `BackHandler`) and confirm it does not strand the user with a no-op and no exit path.

## Performance on real devices

- [ ] No work on the main/UI thread that can block a frame — parsing, image decoding, disk, crypto. `search_code` for a synchronous file/crypto/decode call not wrapped in a background dispatch (a thread, `async`, a worker) inside a component's render/lifecycle method.
- [ ] Lists are recycled/virtualised, not fully materialised. `search_code` for a `map()` rendering a full dataset as a list of components, instead of `FlatList`/`RecyclerView`/`LazyColumn` or an equivalent virtualising list.
- [ ] Images are downsampled to display size before decoding. `search_code` for an image-loading call with no resize/target-size option, against a source image likely to exceed display resolution — a camera capture, a full-resolution upload.
- [ ] Battery and wake-lock usage is bounded; background jobs have a stated budget. `search_code` for a wake-lock acquire or a background-task scheduler registration and confirm a matching release call and a stated time/battery budget exist.

## Out of static reach

- Actual behaviour under real network conditions — latency, packet loss, airplane mode toggled mid-request.
- Real memory pressure and whether the OS actually reclaims the process under it.
- Battery drain and wake-lock duration in practice, versus a stated budget in source.
- Rendering performance — dropped frames, jank — on real device hardware.
- App-store review outcomes for permission usage: this module confirms a permission has a call site, not that a reviewer accepts the justification.
- Platform-API behaviour across the OS version fragmentation the codebase does not branch on.

## Severity guidance

| Situation | Severity |
|---|---|
| Credential in plain local storage, confirmed via `trace_path` from the auth response (traced) | Critical |
| Credential-shaped value in plain local storage, established only by reading the storage call | High |
| Crash on deep link or cold start | High |
| Form or multi-step-flow state lost on backgrounding | High |
| Permission requested but never used | Medium |
| Permanent-denial path dead-ends | Medium |
| Blocking work on the UI thread | Medium |
| Platform branch with an unhandled side | Medium |
