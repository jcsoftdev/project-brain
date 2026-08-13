/**
 * User overrides for model routing: `~/.project-brain/model-routing.json`.
 *
 * The built-in table is a starting point, not a verdict. Someone who knows
 * their own workload — or whose host ships a model we have never heard of —
 * needs a way to correct it that survives the next `setup`.
 *
 * A malformed config NEVER fails setup. Warnings are returned rather than
 * thrown, so the caller decides how loudly to complain while the built-ins
 * carry on working.
 */

import {
  MODEL_ROUTING,
  DEFAULT_HOST_MODELS,
  DATA_DIR,
  type RoutingTier,
  type HostRoutingModels,
} from "../constants.js";
import { join } from "node:path";

const VALID_TIERS: ReadonlyArray<RoutingTier> = ["fast", "balanced", "deep"];

/** Default location of the user's routing overrides. */
export const ROUTING_CONFIG_PATH = join(DATA_DIR, "model-routing.json");

export interface RoutingRule {
  task: string;
  tier: RoutingTier;
  why: string;
}

/** Shape of the on-disk config. Every field optional — partial configs are the point. */
export interface RoutingConfig {
  version?: number;
  models?: Record<string, Partial<HostRoutingModels>>;
  rules?: Array<{ task: string; tier: RoutingTier; why?: string }>;
}

export interface ResolvedRouting {
  models: Record<string, HostRoutingModels>;
  rules: RoutingRule[];
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge user overrides over the built-ins. Pure: no I/O, no mutation of the
 * constants it reads from.
 *
 * `models` deep-merges per host per tier, so a config naming one tier does not
 * silently blank the other two. `rules` appends, except that a rule whose
 * `task` matches a built-in REPLACES it in place — the alternative is a table
 * listing the same task twice with different answers.
 */
export function mergeRoutingConfig(config: RoutingConfig | null): ResolvedRouting {
  const warnings: string[] = [];

  const models: Record<string, HostRoutingModels> = {};
  for (const [host, tiers] of Object.entries(DEFAULT_HOST_MODELS)) {
    models[host] = { ...tiers };
  }

  for (const [host, overrides] of Object.entries(config?.models ?? {})) {
    if (!isPlainObject(overrides)) {
      warnings.push(`model-routing config: models.${host} is not an object — ignored`);
      continue;
    }
    // An unknown host is allowed: a user may run something we do not ship a
    // default for, and refusing it would make the config useless to them.
    const base: HostRoutingModels = models[host] ?? { fast: null, balanced: null, deep: null };
    const merged: HostRoutingModels = { ...base };

    for (const [tier, model] of Object.entries(overrides)) {
      if (!VALID_TIERS.includes(tier as RoutingTier)) {
        warnings.push(`model-routing config: models.${host}.${tier} is not a known tier — ignored`);
        continue;
      }
      merged[tier as RoutingTier] = typeof model === "string" ? model : null;
    }
    models[host] = merged;
  }

  const rules: RoutingRule[] = MODEL_ROUTING.map((r) => ({ ...r }));

  for (const rule of config?.rules ?? []) {
    if (!isPlainObject(rule) || typeof rule.task !== "string" || rule.task.length === 0) {
      warnings.push("model-routing config: a rule has no task — ignored");
      continue;
    }
    if (!VALID_TIERS.includes(rule.tier)) {
      warnings.push(
        `model-routing config: rule "${rule.task}" has unknown tier "${rule.tier}" — ignored`
      );
      continue;
    }

    const existing = rules.findIndex((r) => r.task === rule.task);
    if (existing === -1) {
      rules.push({ task: rule.task, tier: rule.tier, why: rule.why ?? "" });
    } else {
      // Keep the built-in reason when the override omits one: the user is
      // retiering a task they already understand, not un-explaining it.
      rules[existing] = {
        task: rule.task,
        tier: rule.tier,
        why: rule.why ?? rules[existing]!.why,
      };
    }
  }

  return { models, rules, warnings };
}

/** Read and merge the user's routing overrides. Never throws. */
export async function loadRoutingConfig(path = ROUTING_CONFIG_PATH): Promise<ResolvedRouting> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    // Absent is the common case, not an error worth reporting.
    return mergeRoutingConfig(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    const fallback = mergeRoutingConfig(null);
    fallback.warnings.push(`model-routing config at ${path} is not valid JSON (${e.message}) — using defaults`);
    return fallback;
  }

  if (!isPlainObject(parsed)) {
    const fallback = mergeRoutingConfig(null);
    fallback.warnings.push(`model-routing config at ${path} must be a JSON object — using defaults`);
    return fallback;
  }

  return mergeRoutingConfig(parsed as RoutingConfig);
}
