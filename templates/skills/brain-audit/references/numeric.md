# Numeric & Money

Can the arithmetic be trusted? Gate: monetary, quantity, or unit-bearing fields present.

Nothing else in this skill covers this. `database.md` audits schema shape generally but not numeric-type correctness for money specifically; `cross-surface-parity.md` audits recomputation across surfaces but not the arithmetic itself. This module owns whether numbers that represent money, quantities, or physical units are the right type, stay the right type across every hop, and round the same way everywhere they round.

## Money as floating point

- [ ] Every money-named field — `search_code` for `price`, `amount`, `total`, `balance`, `fee`, `cost`, `subtotal`, `tax` — and its declared type at each layer: schema column, ORM/model type, API DTO, frontend type. A `FLOAT`/`DOUBLE`/`number`/plain JSON numeric anywhere in that chain is the headline finding of this module: binary floating point cannot represent most decimal fractions exactly, and money arithmetic on it accumulates visible error. This is `High` at `read`; `find_callers` on the float-typed field's accessor, showing arithmetic actually consumes it, promotes this to `traced`, and `Critical`.
- [ ] The chosen alternative — integer minor units (cents) or a fixed-point/decimal type — applied consistently along the whole chain, not just at the database. `find_callers` on the money field's accessor to confirm every call site treats it as the same representation; a `DECIMAL` column read into a JS `number` at the ORM boundary silently becomes floating point again.
- [ ] JSON serialisation of money at any wire boundary: a decimal type serialised as a JSON number (not a string) loses precision in any consumer using IEEE-754 doubles, even if the producer's own type was exact. `search_code` the response serializer for money fields.

## Rounding

- [ ] Where rounding happens and whether the mode is explicit — `search_code` for `round(`, `toFixed(`, `Math.round`, or a currency-formatting call, and check whether banker's rounding (round-half-to-even — IEEE 754's default tie-break, and Python's `round()`/`decimal.ROUND_HALF_EVEN` default), round-half-up, or truncation is stated versus assumed as a language default. There is no single universal "financial code must use X" rule across standards — round-half-up is the conventional default most non-technical stakeholders assume, while round-half-to-even is required in specific standards-driven contexts precisely to avoid cumulative bias over volume — so the finding is disagreement or silence, not a specific mode being "wrong". Watch for the false assumption in the other direction too: JavaScript's `Math.round()` always rounds an exact half *up* (`Math.round(2.5) === 3`, `Math.round(-2.5) === -2`), which is round-half-up, not banker's rounding, despite running on IEEE 754 doubles underneath — a dev who assumes `Math.round` matches the float standard's own tie-break rule is wrong.
- [ ] The same amount rounded at two different points in the flow (once on calculation, again on display, again on persistence) — trace each rounding site with `find_callers`/`trace_path` from the source value and confirm they use the same mode and the same precision. Disagreement here is invisible in any single-path test and shows up only as "the total doesn't match the sum of the lines." Rule out a display-only rounding that never feeds back into a stored or summed value — the finding is disagreement between two values that must reconcile, not any rounding difference.
- [ ] Division and percentage arithmetic that discards the remainder — `search_code` for a discount, tax, or fee calculated as `amount * rate` with no compensating remainder handling, run against an amount where the result cannot be represented exactly (e.g. dividing by 3).
- [ ] Allocation/splitting logic (split a bill N ways, distribute a total across line items) — `find_symbol` the split function and confirm the parts are made to sum back to the original total (typically by assigning the remainder to the last share, a special case of the standard largest-remainder/Hamilton apportionment method — floor each share, then hand out the leftover units to the shares with the largest fractional remainder), not just independently rounded, which drifts the sum away from the total by a cent or more.

## Currency and units

- [ ] A hardcoded `* 100` / `/ 100` conversion constant applied uniformly to every currency — `search_code` for the literal `100` beside a money field's read/write path. ISO 4217 defines a per-currency minor-unit exponent, and it is not always 2: JPY, KRW, VND, ISK and others use exponent 0 (no minor unit at all — the major unit *is* the smallest unit, so `×100` inflates the stored amount a hundredfold), while BHD, KWD, JOD, OMR, TND, IQD, and LYD use exponent 3 (1/1000ths, e.g. Bahraini fils), so a `/100` truncates and a `×100` under-converts by a factor of ten. A single hardcoded constant is provably wrong for both edges of that range the moment the codebase touches one of these currencies.
- [ ] Amount values carried without their currency attached — a function or column holding a bare number where the currency is assumed rather than stored alongside it. `search_code` for arithmetic between two amount variables and check whether their currencies were ever compared; adding `100` (USD) to `100` (EUR) is nonsense the type system will not catch if currency isn't part of the value.
- [ ] Exchange-rate application — `find_symbol` the rate-application function and `Read` whether it uses the rate valid at the transaction time versus whatever the latest cached rate happens to be, and whether the rate itself carries its own timestamp. Cross-reference `temporal.md` for whether that timestamp is stored as a proper instant.
- [ ] Any field carrying bytes, milliseconds, kilometres, kilograms, or another unit whose name does not say so (`size`, `duration`, `distance`, `weight`) — `search_code` the field name and read the nearest comment or usage to infer the intended unit, then check every consumer agrees.
- [ ] Unit conversions applied twice (a value already in minor units gets divided by 100 again) or never (a value assumed to be in one unit is used directly in a formula expecting another) — trace with `find_callees` from the conversion function to confirm it is called exactly once per value on its way to use.

## Precision and comparison

- [ ] Integer overflow or precision loss at boundaries — a large integer ID or amount crossing a JSON boundary into a language whose numbers are IEEE-754 doubles (JavaScript, or any `JSON.parse` consumer) silently loses precision beyond `Number.MAX_SAFE_INTEGER` (2^53 − 1 = 9,007,199,254,740,991 — the limit of the double's 53 bits of integer precision, 52 stored mantissa bits plus one implicit leading bit). This is concretely reproducible, not theoretical: `JSON.parse("9007199254740993")` returns `9007199254740992`, silently, with no error. `search_code` for large numeric IDs (order numbers, ledger entries) serialised as JSON numbers rather than strings.
- [ ] Floating-point values compared for equality (`===`, `==`, `.equals()`) anywhere in the codebase — `search_code` for `===` or `==` beside a variable that is a computed float. This is a near-guaranteed false negative on values that are mathematically equal but bit-different due to accumulated rounding. Rule out comparison against an exact, non-computed constant (`0`, a fixed sentinel) — the risk is two independently rounded results, not a comparison to a literal.
- [ ] Database numeric column precision/scale versus the application type's range — `find_symbol` the column definition and compare it against the application type's range: a `DECIMAL(10,2)` column paired with an application type that permits more precision is silently truncated on write with no error surfaced.
- [ ] Division by a value that can be zero (a rate, a count used as a denominator) — `search_code` the division site and check whether the denominator's zero case is validated before use or produces `NaN`/`Infinity`/a runtime exception that propagates into a stored or displayed value.
- [ ] `NaN` and `Infinity` reachability into a persisted or serialised value — `trace_path` from the enclosing function of a division/parsing site that can produce `NaN`/`Infinity` to the serialiser/persist function: a `NaN` written to a numeric column, or serialised into JSON (where it becomes `null` or invalid JSON depending on the serializer), silently corrupts the value with no error at the point of injection.

## Sign and bounds

- [ ] Negative-amount validation on fields that should never go negative (a balance, a quantity) versus ones that legitimately can (a refund, an adjustment) — `find_symbol` the validation on the write path and confirm the sign constraint matches the field's real semantics rather than being uniformly absent or uniformly forbidding negatives.
- [ ] Quantity or amount fields with no upper-bound validation before an arithmetic operation that could overflow or produce an absurd result (a quantity field multiplied by a price with no sanity check) — `find_symbol` the validation on the write path and `trace_path` from the user-input entry point to the arithmetic operation to confirm it is reachable from user input, not just internal computation.

## Recomputation

- [ ] Totals, subtotals, or derived amounts computed in more than one place (backend on save, frontend for display, a report job, a webhook payload) — `search_code` the computation formula in each location and diff them line by line. Cross-reference `cross-surface-parity.md`, which owns the general recomputation-drift pattern; report the numeric-specific instance here with the exact formula divergence.

## Out of static reach

- Whether rounding differences are actually visible to a user at production data volumes.
- Real-world exchange rate feed staleness or provider outages.
- Cumulative floating-point drift over a live dataset's actual transaction history.
- Currency-conversion correctness against the specific jurisdiction's legally mandated rounding rules.

## Severity guidance

| Situation | Severity |
|---|---|
| Money stored or transmitted as binary float anywhere in the chain (traced) | Critical |
| Split/allocation logic that does not sum back to the total | High |
| Arithmetic between two amounts whose currencies are never checked | High |
| Large ID or amount losing precision across a JSON boundary | High |
| Hardcoded ×100/÷100 conversion applied to a non-exponent-2 currency | High |
| Floating-point equality comparison on computed monetary values | Medium |
| Rounding mode unstated, or disagreeing between two computation sites | Medium |
| Unit-bearing field with no unit in its name and inconsistent consumers | Medium |
| Exchange rate applied without a timestamp tying it to the transaction | Medium |
| Totals recomputed independently in more than one surface | Medium |
| Division with an unvalidated zero-capable denominator | Medium |
| `NaN`/`Infinity` reachable into a persisted or serialised value | Medium |
| Sign constraint absent or wrong for the field's real semantics | Medium |
| No upper-bound validation before a user-input-driven multiplication | Low |
| DB column precision narrower than the application type | Low |
