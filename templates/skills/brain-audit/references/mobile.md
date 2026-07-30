# Mobile

Native or cross-platform mobile concerns. Gate: a native mobile project was detected.

Mobile amplifies every defect the other modules find: the network is unreliable, the process can die at any moment, and the user cannot read a stack trace. Audit accordingly.

## Lifecycle

- [ ] State survives backgrounding. Anything held only in memory is gone when the OS reclaims the process.
- [ ] In-flight work is paused or cancelled on background, and resumed or abandoned deliberately on foreground.
- [ ] Deep links and cold starts reach the same state as in-app navigation. A screen reachable only through a parent that initialises it will crash on deep link.
- [ ] Rotation and configuration changes do not lose user input.

## Network reality

- [ ] Every request assumes it can fail, be slow, or arrive twice. Offline is a state, not an error.
- [ ] Retries are bounded and backed off. An unbounded retry on a metered connection is a cost defect too — cross-reference `Cost`.
- [ ] Large payloads are paginated or streamed. Mobile memory limits are lower than the developer's machine.
- [ ] Uploads survive interruption, or explicitly restart.

## Permissions

- [ ] Every permission requested is actually used. `search_code` the manifest/plist entries and confirm each has a call site — an unused permission is a store-review risk and a trust cost.
- [ ] Denial is handled, including permanent denial, with a path forward rather than a dead end.
- [ ] Permissions are requested at the moment of need with context, not all at launch.

## Storage and secrets

- [ ] Tokens and credentials use the platform keystore, never plain preferences or a local file. `search_code` for the preference API alongside token-like keys.
- [ ] Cached user data is clearable, and logout actually clears it.
- [ ] Local database migrations exist and are tested against the previous version's schema.

## Platform integration

- [ ] Both platforms are covered wherever the code branches on OS. A branch handling one platform and falling through on the other is a half-wired feature — cross-reference `flow-integrity.md`.
- [ ] Minimum OS version claimed by the manifest matches the APIs actually used.
- [ ] Safe areas, notches, and system bars are respected.
- [ ] Back-navigation follows platform convention, including hardware back.

## Performance on real devices

- [ ] No work on the main/UI thread that can block a frame — parsing, image decoding, disk, crypto.
- [ ] Lists are recycled/virtualised, not fully materialised.
- [ ] Images are downsampled to display size before decoding.
- [ ] Battery and wake-lock usage is bounded; background jobs have a stated budget.

## Severity guidance

| Situation | Severity |
|---|---|
| Credential in plain local storage | Critical |
| Crash on deep link or cold start | High |
| State lost on backgrounding | High |
| Unbounded retry loop | High |
| Permission requested but never used | Medium |
| Permanent-denial path dead-ends | Medium |
| Blocking work on the UI thread | Medium |
| Platform branch with an unhandled side | Medium |
