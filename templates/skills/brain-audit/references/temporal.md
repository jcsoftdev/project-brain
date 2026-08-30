# Temporal

Does the code agree with itself about what time it is? Gate: dates, schedules, expiry, or scheduling logic present.

`database.md` notes, in one line, whether timestamp columns are timezone-aware. `testing.md` notes, in one line, whether tests depend on wall-clock time. Neither goes further than that. This module owns everything else about temporal correctness: the instant-versus-civil-time distinction that causes most date bugs, DST arithmetic, serialisation at every boundary, and the clock as a dependency nobody injected. If a finding is about the *storage type* of a column, it belongs in `database.md`; if it is about *what the code does* with the value once read, it belongs here.

The instant/civil distinction this module probes for by hand is, as of ECMAScript 2026, a distinction the language itself now names: TC39's Temporal proposal reached Stage 4 in March 2026 and ships unflagged in Firefox 139+, Chrome/Edge 144+, and Node.js 26+ (not yet in Safari as of this writing) — `Temporal.Instant` for a fixed point in time, `Temporal.PlainDateTime`/`Temporal.PlainDate` for a genuinely civil value with no zone attached, and `Temporal.ZonedDateTime` for a value that carries both. A codebase still on a modern runtime but exclusively using legacy `Date` for a "deliver at 9am local" feature had, until recently, no first-party type to reach for instead — that gap is closing, and its presence is useful context, not itself a defect.

## Storage and representation

- [ ] Every timestamp column's declared type: `search_code` the schema/migrations for date fields, then `find_symbol` the column type. `TIMESTAMP WITHOUT TIME ZONE` (or a driver default that behaves like it) storing a value the application treats as an instant is a defect — the offset is silently lost, and every read is a guess about what zone it was written in.
- [ ] The inverse: a genuinely civil datetime — "9am local, wherever local is" — stored in a timezone-aware column. This double-converts on every read, because the column assumes a single instant and civil time by definition is not one.
- [ ] Naive local time (`new Date()`, `datetime.now()`, `time.Now()` with no explicit zone) used at a boundary that is supposed to represent a fixed instant — a token expiry, an audit log entry, a scheduled-at field. Rule out first: a value that is genuinely display-only and never compared or persisted is not a defect.
- [ ] The instant/civil conflation itself: a "deliver at 9am" feature that stores a single UTC instant instead of a wall-clock time plus a zone. This is correct in the sender's zone and wrong in every other zone, and DST will additionally shift it twice a year.

## DST and calendar arithmetic

- [ ] Any `addDays`/`addHours`-style call used to mean "the same wall-clock time tomorrow" rather than "24 hours from now" — `search_code` for day-arithmetic helpers and read what they add. Adding 24 hours across a DST transition lands one hour off the intended wall-clock time.
- [ ] Recurring schedules (`search_code` for cron-like fields, `RRULE`, or a "repeat every" config) evaluated in a fixed offset rather than a named zone. A schedule anchored to `UTC-5` drifts by an hour relative to local time twice a year; one anchored to `America/Bogota` does not, because Bogota has no DST — the distinction matters exactly where DST exists.
- [ ] Time ranges spanning a "spring forward" gap (a wall-clock hour that never occurs) or a "fall back" overlap (an hour that occurs twice). A range built from raw wall-clock start/end without zone-aware arithmetic can silently normalise a nonexistent time to something else, or double-count the ambiguous hour.
- [ ] Whether ambiguous/nonexistent-hour disambiguation is explicit at each construction site rather than left to whatever the library defaults to — `search_code` for tz-aware datetime construction (Python's `fold` attribute or `is_dst=`, JS's `Temporal.ZonedDateTime.from(..., { disambiguation })`) with no argument supplied. Defaults genuinely differ by library and this is a common false assumption: Python's `zoneinfo` (PEP 495) and `pytz` both silently pick a side (the earlier occurrence, or `is_dst=False`) with no error, while `pandas.Series.dt.tz_localize` raises by default (`ambiguous='raise'`, `nonexistent='raise'`) — a codebase mixing both in one pipeline can have one path fail loudly and the adjacent one fail silently on the same kind of input.
- [ ] Month-end and leap-year arithmetic: adding a month to 31 January, or a year to 29 February. `search_code` for manual `setMonth`/`setDate`/`setFullYear` chains rather than a date library's calendar-aware add.
- [ ] Week-numbering assumptions (ISO week vs. US week, week start on Sunday vs. Monday) applied inconsistently between a report and the UI that renders it.
- [ ] A container/base-image build (`Dockerfile`, base-image manifest) with no mechanism to keep its bundled tz database current — `search_code` the Dockerfile for a `tzdata` package install with no update step, or a base image pinned by digest with no rebuild trigger. The IANA tz database releases several times a year whenever a government changes DST/offset rules (real 2026 examples: Alberta moving to permanent UTC-6, Morocco moving to permanent UTC+0); an image built once and never rebuilt computes the *old* rule for that zone until it is, which reproduces as "the time is right most of the year, then off by an hour around the transition." This is a `read` finding on the Dockerfile itself, not a claim about the deployed environment's actual tzdata version — that stays under Out of static reach.

## Serialisation and boundaries

- [ ] Every wire boundary — API response, queue payload, log line, cache key — for date fields: does serialisation preserve the offset (ISO 8601 with `Z`/offset, or an explicit epoch) or silently drop it (a bare `YYYY-MM-DD HH:mm:ss`)? `search_code` the serializer/formatter used at each boundary. A numeric offset alone (`-04:00`) doesn't say which named zone/DST rule produced it — RFC 9557's Internet Extended Date/Time Format (IXDTF, the format `Temporal.ZonedDateTime.toString()` emits) adds a bracketed zone-name suffix (`-04:00[America/New_York]`) precisely to keep that disambiguated across a wire boundary; its absence isn't a defect on its own, but a codebase reinventing the same suffix ad hoc is a signal to check the two ends actually agree on the convention.
- [ ] A queue payload or webhook body carrying a naive timestamp string with no documented zone contract between producer and consumer — `trace_path` from producer to consumer to confirm both sides agree, rather than assuming they do.
- [ ] Comparisons between values of different kinds — an instant compared to a civil datetime, or a stored UTC value compared to a freshly-constructed local `Date` without normalising both sides first.
- [ ] `now()` (or its language equivalent) called more than once within a single logical operation — `search_code` for repeated `Date.now()`/`time.Now()` calls inside one function or one request. Two calls milliseconds apart can straddle a rounding boundary and disagree, and a "created before it expired" check built from two separate `now()` reads is not atomic.

## Clock as a dependency

- [ ] `Date.now()`, `new Date()`, or the platform equivalent called directly deep inside business logic rather than through an injected clock/`now` parameter. `find_callers` on the logic function — if none of its callers can supply a fixed time, the logic is untestable for anything time-dependent and every "what happens near midnight / near expiry" case is unverifiable without wall-clock waiting.
- [ ] Expiry and TTL arithmetic: off-by-one at the boundary (`<` vs `<=` against the expiry instant), and which clock performs the check — client-supplied time versus server time. A client clock that is wrong, or deliberately manipulated, must never be the authority for an expiry decision.
- [ ] Cron/schedule expressions read against their documented intent — `search_code` the expression and compare it to what the surrounding comment or config name claims it does. A drifted expression (`0 0 * * 1` labelled "daily") is a silent scope change.
- [ ] What happens to a missed scheduled run (process was down, deploy in progress): does the job catch up, skip, or run every missed occurrence at once on restart? `find_callees` from the scheduler entry point to see if a catch-up path exists at all.

## Presentation

- [ ] User-facing date/time formatting rendered in the server's zone rather than the user's — `search_code` for a formatter call with no zone argument on a value ultimately shown to a user. Cross-reference `i18n.md` for locale-specific format conventions (12h/24h, date order); this module owns whether the *zone* is right, `i18n.md` owns whether the *format* is right.

## Out of static reach

- Whether a DST transition actually reproduces the bug in the deployed environment's real timezone database version.
- Clock skew between distributed nodes at runtime.
- Whether a cron scheduler's actual trigger times match the expression under real load (delayed execution, overlapping runs).
- User-perceived correctness of "relative time" displays ("3 hours ago") as real time elapses.

## Severity guidance

| Situation | Severity |
|---|---|
| Instant stored as naive local time at a security-relevant boundary (token/session expiry) | Critical |
| Expiry checked against client-supplied clock | High |
| Timestamp column type disagrees with what the application treats it as | High |
| Serialisation drops offset at a cross-service boundary | High |
| `addDays`-style arithmetic used across a DST boundary for wall-clock intent | Medium |
| Ambiguous/nonexistent-hour disambiguation left to an unstated library default | Medium |
| `now()` called multiple times in one operation with no single source of truth | Medium |
| Hardcoded clock access preventing time-dependent logic from being tested | Medium |
| Missed-schedule catch-up behaviour undefined | Medium |
| User-facing time rendered in server zone instead of user zone | Medium |
| Base image with no tzdata update mechanism | Low |
| Week-numbering or month-end drift between two surfaces | Low |
