## Model routing for delegated agents

<!-- model-routing-version: {{contentVersion}} -->

When spawning a sub-agent, pick its tier deliberately. Leaving every delegation
on the session's default model means paying deep-tier prices for lookups, or
getting fast-tier answers to questions that need judgment.

A tier is a claim about the work, not about a vendor's lineup:

{{tierMeanings}}

{{modelRoutingTable}}

Shortcut: sub-agent output is yes/no or a list → fast. Output is code or
synthesis → balanced. Output is "which approach is better" → deep.

**On {{hostName}}:** {{howToApply}}
{{labelRule}}{{advisorRule}}
### When NOT to delegate

Delegation is not free — it pays a full context bootstrap before the sub-agent
reads its first line. Reading 1–3 files to decide or verify something is
cheaper inline. Delegate when the work is 4+ files of exploration, or any
read-then-write pair where the reading would otherwise land in your context and
stay there.

### Escalate, don't start deep

Run the cheapest tier the task table allows. On a failed or empty result,
retry one tier up. The escalation pays because most delegations never need it,
and because the fast tier is far cheaper than the rest — see Relative cost.
A task the table already puts at `deep` goes there first: a wrong answer from a
cheaper tier costs a retry plus the parent's turns spent acting on it.

### Verification must be asymmetric

Never verify with the model that produced the work — same blind spots, and it
rubber-stamps its own output. This is why adversarial review sits at `deep`
even when the code under review was written at `balanced`. The point is not a
better reader; it is a different one.

### Effort is a second axis

Where the host exposes a reasoning-effort setting, raise it before raising the
tier: balanced at high effort often beats deep at low effort, and costs less.
Current models at low or medium effort often match the previous generation at
high, so start low for routine work and raise it only when the result falls
short. Tier and effort are independent knobs, and only one of them is usually
the answer.

### Run independent delegations in parallel

Delegations that do not depend on each other go out in one message. This is
orthogonal to tier and multiplies the saving — three fast lookups in parallel
cost the same tokens as three in sequence, and a third of the wall-clock.

### Relative cost

Per token, at list price, the gaps are uneven. On the Claude lineup, fast to
balanced (Haiku 5.5 to Sonnet 5.5) is about 20×, balanced to deep (Sonnet 5.5
to Opus 5.5) is 2×, and Fable 5.1 is 2.5× Opus. So moving a lookup down to fast
saves far more than moving a judgment call down from deep, and a failed fast
attempt retried one tier up still costs a fraction of starting at balanced.
Between balanced and deep the price rarely settles the choice: what does is the
tokens spent. A deeper tier at high effort thinks longer, and a cheap tier that
gets it wrong costs a retry and the parent's turns acting on it. Judge by the
cost of the finished task, not of one call.
(https://platform.claude.com/docs/en/models/overview.md)

### project-brain's own routing

`search_context` and explore-class questions return large results; run them
inside a sub-agent so your own context keeps the conclusion and not the
transcript. Structural lookups — `find_symbol`, `find_callers`, `find_callees`,
`impact` — return a handful of lines and belong inline.

Override any of this in `{{configPath}}`: `models` remaps tiers per host,
`rules` adds or retiers a task.
