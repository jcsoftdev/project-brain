import template from "../../templates/model-routing.md" with { type: "text" };
import {
  ROUTING_TIERS,
  ROUTING_CONTENT_VERSION,
  renderModelRoutingTable,
  type HostRoutingModels,
} from "../constants.js";
import {
  mergeRoutingConfig,
  ROUTING_CONFIG_PATH,
  type ResolvedRouting,
} from "./model-routing-config.js";
import type { AIToolRegistrar } from "../registrars/types.js";

/**
 * Render the model-routing guidance for ONE host.
 *
 * The section is host-specific by necessity, not by preference. Four of the six
 * supported hosts default sub-agents to inheriting the parent's model, and set
 * the model in an agent DEFINITION file rather than at the call — so the old
 * single-template advice ("pass the `model` param") was simply false for most
 * of them. What ports is the tier table; what does not is every word about
 * where to put the answer.
 *
 * The template is embedded at build time (`with { type: "text" }`), not read
 * from disk at runtime — `import.meta.dir`-relative reads break under
 * `bun build --compile`, where the compiled binary has no real filesystem
 * path back to a sibling `templates/` directory.
 */
export async function getModelRoutingSection(
  registrar: AIToolRegistrar,
  resolved?: ResolvedRouting
): Promise<string> {
  const routing = registrar.routing;
  if (!routing) {
    throw new Error(`${registrar.name} has no routing descriptor — it is not an eligible host`);
  }

  const config = resolved ?? mergeRoutingConfig(null);
  const models: HostRoutingModels =
    config.models[routing.hostKey] ?? routing.models ?? { fast: null, balanced: null, deep: null };

  const tierMeanings = ROUTING_TIERS.map(
    (t) => `- **${t.tier}** — ${t.meaning}`
  ).join("\n");

  return template
    .replace(/\{\{contentVersion\}\}/g, String(ROUTING_CONTENT_VERSION))
    .replace(/\{\{tierMeanings\}\}/g, tierMeanings)
    .replace(/\{\{modelRoutingTable\}\}/g, renderRulesTable(config, models))
    .replace(/\{\{hostName\}\}/g, registrar.name)
    .replace(/\{\{howToApply\}\}/g, routing.howToApply)
    .replace(/\{\{labelRule\}\}/g, renderLabelRule(routing.labelField))
    .replace(/\{\{configPath\}\}/g, ROUTING_CONFIG_PATH);
}

/**
 * Table rows come from the RESOLVED rules (built-ins plus user overrides), so a
 * retiered task shows its new tier rather than the shipped default.
 */
function renderRulesTable(config: ResolvedRouting, models: HostRoutingModels): string {
  const named = Object.values(models).some((m) => m !== null);
  const header = named ? "| Task | Tier | Model | Why |" : "| Task | Tier | Why |";
  const separator = named ? "| --- | --- | --- | --- |" : "| --- | --- | --- |";
  const rows = config.rules.map((r) =>
    named
      ? `| ${r.task} | ${r.tier} | ${models[r.tier] ?? "—"} | ${r.why} |`
      : `| ${r.task} | ${r.tier} | ${r.why} |`
  );
  return [header, separator, ...rows].join("\n");
}

/**
 * A routing decision the user cannot see is a routing decision they cannot
 * correct — so the model goes in the sub-agent's visible label.
 *
 * Rendered only where the host HAS a per-call label. Everywhere else the
 * visible name belongs to the agent definition, fixed before the call exists,
 * and there is nowhere to put a per-call prefix. Inventing a field name would
 * be worse than saying nothing.
 */
function renderLabelRule(labelField: string | null): string {
  if (labelField === null) return "";

  return `
### Name the model in the delegation's label

Nothing on screen says which model is running a sub-agent. Put it in
${labelField}, as a prefix: \`haiku: locate auth handler\`, \`opus: refute
finding #3\`. Model first — that is the part being audited at a glance.

Keep it to the bare model id. That field is meant to be 3–5 words, so
\`[deep/opus]\` spends two tokens to say what one already said.
`;
}

// Deliberately no re-export of a zero-arg variant. A caller who does not know
// which host they are writing for cannot produce correct guidance, and a
// convenience default would quietly resurrect the Claude-only text.
