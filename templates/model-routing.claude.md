## Model routing for delegated agents

When spawning a sub-agent (Agent tool, Task tool, or workflow step), pick its model explicitly — don't leave it on the default for every call.

{{modelRoutingTable}}

Shortcut: sub-agent output is yes/no or a list → haiku. Output is code or synthesis → sonnet. Output is "which approach is better" → opus.

Pass the choice via the `model` param on the delegation call. Omit it only to inherit the current session's model.
