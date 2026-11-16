# Delegating a UX review

## Splitting by scope

| Scope | Unit of delegation | Parent keeps |
|-------|--------------------|--------------|
| Whole app | One subagent per priority task, plus one for cross-cutting IA (global nav, search, naming across areas) | Task selection, context, merge, redesign, validation plan |
| One feature | One subagent per task only when tasks share no state; otherwise inline | Same |
| One screen | No delegation | Everything |

- Pick the model with `brain-model-routing`. A diagnosis or a redesign is judgment work.
- Launch independent subagents in one message.
- Each subagent opens and closes its own tabs. Subagents share the parent's browser server, so tell each one which tab it owns.

## Subagent brief

Each brief carries everything the subagent needs, because it starts with no context:

```
Goal: walk and diagnose one task of a UX review. Read-only: no fixes, no commits.
Product and access: <URL / repo / screenshots>, signed-in session: <yes/no, which>.
User and role: <...>. Product goal: <...>. Design system: <DESIGN.md, tokens, kit>.
Task: <user goal, no route>. Entry point: <...>. Success criterion: <...>.
Also walk: wrong-choice path <...>, failure path <...>, return visit.
Viewports: desktop 1440, mobile 375x812x3,mobile,touch (if relevant).
Read first: <skill dir>/references/protocol.md (four levels, evidence types).
Rules: chrome-devtools first; non-local targets read-only; never type passwords;
never invent data; mark unverified claims as hypothesis; close your tabs.
Return (under 600 words): step list with screenshot paths; findings as rows
(task/step, screen+state, problem, evidence type+pointer, reproduced, impact class);
what you could not check and why.
```

## Merging

1. Dedupe: findings with the same screen, state and cause are one finding. Keep every task in which it appeared, and raise its impact if it blocks more than one task.
2. Check the evidence: spot-check one reproduced finding per subagent yourself before trusting the rest.
3. Find cross-task patterns: the same problem on several screens points to a design-system or IA cause. Report it once at that level.
4. Do the redesign and the validation plan in the parent, so the flows stay consistent with one another.
