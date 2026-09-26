import { join } from "node:path";
import type { AIToolRegistrar } from "../registrars/types.js";

/**
 * What one setup unit looks like on disk right now.
 *
 * `unavailable` is not a failure — it means the unit cannot apply on this
 * machine at all (no host detected, no skills root, Ollama absent). Such a unit
 * is shown with its reason and no checkbox rather than hidden, so nobody has to
 * wonder why a skill they expected is missing from the list.
 */
export type UnitState = "absent" | "current" | "stale" | "foreign" | "unavailable";

/** Everything a unit needs, and every path a test must be able to redirect. */
export interface SetupContext {
  dataDir: string;
  /** Registrars whose `isInstalled()` returned true. */
  installed: AIToolRegistrar[];
  /** Path the MCP entry should point at. */
  serverPath: string;
  claudeSettingsPath: string;
  recordConfigPath: string;
  selectionPath: string;
  skillTargetDirs: string[];
  recordConnection: { mode: "fresh" | "live"; cdpPort: number };
  hookStrict: { routing: boolean; worktree: boolean };
  skipOllama: boolean;
  /**
   * Overrides `ROUTING_CONFIG_PATH` (which is homedir-derived) so a test can
   * redirect it — `os.homedir()` cannot be redirected under `bun test`, unlike
   * a real process's `HOME`. Optional so `undefined` keeps meaning "use the
   * real default" in production.
   */
  routingConfigPath?: string;
  /**
   * Overrides the per-user service directory (LaunchAgents or systemd user
   * units), for the same reason as `routingConfigPath`: tests must not read or
   * write the real one.
   */
  serviceDir?: string;
  /**
   * Non-interactive token for `config:reranker`, from `--reranker-token`.
   * When absent, `apply()` falls back to `TYPESAFE_API_KEY`, then an
   * interactive prompt.
   */
  rerankerToken?: string;
  /**
   * Injectable for testing; defaults to the real `promptRerankerToken` from
   * `src/interactive.js`, which itself only prompts in a genuine interactive
   * session (see `isInteractive`).
   */
  promptRerankerToken?: () => Promise<string | null>;
}

/**
 * One installable surface, in the one shape every surface now shares.
 *
 * Before this existed, five surfaces had five different consent shapes: MCP
 * registration and the worktree hooks were automatic, the routing hooks rode on
 * the model-routing answer, `record-config.json` was always rewritten, and five
 * skills shared a single yes/no. Nothing could be chosen independently because
 * nothing agreed on what "chosen" meant.
 */
export interface SetupUnit {
  /** Stable across releases — it is persisted in the selection file. */
  id: string;
  group: "Hosts" | "Guidance" | "Skills" | "Other";
  label: string;
  /** One line, shown beside the checkbox. */
  description: string;
  /** Checked the first time this unit is ever offered. */
  defaultSelected: boolean;

  inspect(ctx: SetupContext): Promise<UnitState>;
  apply(ctx: SetupContext): Promise<void>;
  remove(ctx: SetupContext): Promise<void>;
}

/** One-line descriptions, kept beside the ids they belong to. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  "brain-audit": "whole-project audit: dead code, orphan UI, broken flows, security findings",
  "brain-commit": "writes commit messages in the convention the repository already uses",
  "brain-okf": "records the reasoning behind code as an Open Knowledge Format concept",
  "brain-record": "records a branch's flow as video evidence for a PR or ticket",
  "brain-style": "keeps generated code declarative — comments only where the code cannot speak",
  "brain-worktree": "gives an isolated worktree its own brain and its own port",
};

/**
 * A unit per shipped skill.
 *
 * Every target directory is treated as one unit: a skill is either installed
 * everywhere it can go or nowhere. Per-root selection would be a second axis
 * nobody asked for, and six of the eight hosts share `~/.agents/skills` anyway.
 * `inspect` therefore reports the WORST state across roots, so a single stale
 * or foreign copy is visible rather than averaged away.
 */
export function skillUnits(): SetupUnit[] {
  // Imported lazily inside each method: the skills module embeds every shipped
  // markdown file as a string, and the flag parser must not pay for that.
  return Object.keys(SKILL_DESCRIPTIONS).map((name) => ({
    id: `skill:${name}`,
    group: "Skills" as const,
    label: name,
    description: SKILL_DESCRIPTIONS[name]!,
    defaultSelected: true,

    async inspect(ctx: SetupContext): Promise<UnitState> {
      if (ctx.skillTargetDirs.length === 0) return "unavailable";
      const { inspectOwnership, readSkillStamp, MANIFEST_STAMP } = await import(
        "../rules/skills.js"
      );

      const states: UnitState[] = [];
      for (const root of ctx.skillTargetDirs) {
        const skillDir = join(root, name);
        const ownership = await inspectOwnership(skillDir);
        if (ownership === "absent") states.push("absent");
        else if (ownership !== "ours") states.push("foreign");
        else {
          const stamp = await readSkillStamp(skillDir);
          states.push(stamp.hash === MANIFEST_STAMP ? "current" : "stale");
        }
      }

      // Worst-first: a problem anywhere is the answer.
      for (const worst of ["foreign", "stale", "absent"] as const) {
        if (states.includes(worst)) return worst;
      }
      return "current";
    },

    async apply(ctx: SetupContext): Promise<void> {
      const { installOneSkill } = await import("../rules/skills.js");
      await installOneSkill(ctx.skillTargetDirs, name);
    },

    async remove(ctx: SetupContext): Promise<void> {
      const { removeSkill } = await import("../rules/skills.js");
      for (const root of ctx.skillTargetDirs) {
        await removeSkill(join(root, name));
      }
    },
  }));
}

/**
 * The id segment for a host.
 *
 * Lowercase with whitespace stripped, so "Claude Code" and "Gemini CLI" produce
 * ids stable enough to persist: `host:claudecode`, `host:geminicli`. Derived
 * rather than hand-mapped because the registrar list is the source of truth for
 * which hosts exist.
 */
export function hostKeyOf(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

/**
 * A unit per detected host: the MCP registration and its rules file together.
 *
 * The two are ONE unit on purpose. A rules file describing an MCP server that
 * was never registered is instructions for a tool that is not there, and
 * splitting them would let a user build exactly that state.
 *
 * `inspect` can only answer honestly for hosts that expose
 * `mcpConfigTarget()`. Codex registers through `codex mcp add` against a TOML
 * only that CLI can safely rewrite, so it reports `absent` and re-applying is a
 * harmless no-op — better than claiming a state we cannot read.
 */
export function hostUnits(installed: AIToolRegistrar[]): SetupUnit[] {
  return installed.map((registrar) => ({
    id: `host:${hostKeyOf(registrar.name)}`,
    group: "Hosts" as const,
    label: registrar.name,
    description: "registers the project-brain MCP server and writes its rules file",
    defaultSelected: true,

    async inspect(ctx: SetupContext): Promise<UnitState> {
      const present = ctx.installed.some((r) => r.name === registrar.name);
      if (!present) return "unavailable";

      const target = registrar.mcpConfigTarget?.();
      if (!target) return "absent";

      let registered: boolean;
      try {
        const parsed = JSON.parse(await Bun.file(target.path).text()) as Record<string, unknown>;
        const container = parsed[target.containerKey] as Record<string, unknown> | undefined;
        registered = Boolean(container && "project-brain" in container);
      } catch {
        // Missing file, or JSONC we refuse to parse. Both mean "not registered
        // as far as we can prove", and apply() handles the JSONC case by
        // raising UnparseableConfigError, which setup already reports.
        registered = false;
      }
      if (!registered) return "absent";

      // Registration alone does not prove the rules file is still what the
      // current template would write — a stale block from an older release
      // survives here forever otherwise. A host with no rules file (VS Code,
      // Zed) has nothing to go stale.
      const rulesPath = registrar.rulesFilePath?.();
      if (!rulesPath) return "current";

      const { isGlobalRulesCurrent } = await import("../rules/global.js");
      const toolKey = hostKeyOf(registrar.name)
        .replace("claudecode", "claude")
        .replace("geminicli", "gemini");
      return (await isGlobalRulesCurrent(rulesPath, toolKey)) ? "current" : "stale";
    },

    async apply(ctx: SetupContext): Promise<void> {
      await registrar.register(ctx.serverPath);
      const { getGlobalRules } = await import("../rules/global.js");
      const toolKey = hostKeyOf(registrar.name)
        .replace("claudecode", "claude")
        .replace("geminicli", "gemini");
      await registrar.writeRules(await getGlobalRules(toolKey));
    },

    async remove(_ctx: SetupContext): Promise<void> {
      const { removeSection } = await import("../rules/section-marker.js");
      const target = registrar.mcpConfigTarget?.();

      if (target) {
        try {
          const parsed = JSON.parse(await Bun.file(target.path).text()) as Record<string, unknown>;
          const container = parsed[target.containerKey] as Record<string, unknown> | undefined;
          if (container && "project-brain" in container) {
            delete container["project-brain"];
            await Bun.write(target.path, `${JSON.stringify(parsed, null, 2)}\n`);
          }
        } catch {
          // Unparseable is not ours to repair — the same rule the installers use.
        }
      }

      // The rules file is a marked section inside a file the user owns, so only
      // our section goes. `removeSection` no-ops when the markers are absent.
      const rulesPath = registrar.rulesFilePath?.();
      if (rulesPath) await removeSection(rulesPath);
    },
  }));
}

/**
 * Read Claude Code's settings, distinguishing "absent" from "not ours".
 *
 * `null` means there is nothing there, which is normal on a first run.
 * `"unparseable"` means there IS content we cannot parse, and every caller
 * treats that as untouchable: rewriting it from scratch would silently replace
 * whatever the user has.
 */
async function readClaudeSettings(
  path: string
): Promise<Record<string, unknown> | null | "unparseable"> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "unparseable";
  }
}

/** True when any hook group anywhere in the settings runs `command`. */
function settingsHaveCommand(settings: Record<string, unknown> | null, command: string): boolean {
  if (!settings) return false;
  return JSON.stringify(settings.hooks ?? {}).includes(command);
}

/**
 * Build a unit for one hook pair, since routing and worktree differ only in
 * which functions they call and which command proves they are installed.
 *
 * `load` is a closure rather than the two functions directly because
 * `claude-settings.js` is imported lazily — the flag parser and the checklist
 * must not pay to load it just to know a unit exists.
 */
function hookUnit(spec: {
  id: string;
  label: string;
  description: string;
  probe: string;
  strictOf: (ctx: SetupContext) => boolean;
  load: () => Promise<{
    upsert: (existing: object | null, options: { strict: boolean }) => object;
    remove: (existing: object | null) => object;
  }>;
}): SetupUnit {
  return {
    id: spec.id,
    group: "Guidance",
    label: spec.label,
    description: spec.description,
    defaultSelected: true,

    async inspect(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") return "foreign";
      return settingsHaveCommand(settings, spec.probe) ? "current" : "absent";
    },

    async apply(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") {
        console.warn(
          `Warning: ${ctx.claudeSettingsPath} is not valid JSON — ${spec.label} not installed.`
        );
        return;
      }
      const { upsert } = await spec.load();
      const next = upsert(settings, { strict: spec.strictOf(ctx) });
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
    },

    async remove(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable" || settings === null) return;
      const { remove } = await spec.load();
      const next = remove(settings);
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

/**
 * A unit that owns one key in Claude Code's `settings.json`.
 *
 * A value already there that is not ours is `foreign` — the user's choice —
 * so apply leaves it and remove never deletes it; only the exact value this
 * unit writes is treated as ours.
 */
function settingsKeyUnit(spec: {
  id: string;
  label: string;
  description: string;
  defaultSelected: boolean;
  load: () => Promise<{
    state: (settings: Record<string, unknown> | null) => "absent" | "current" | "foreign";
    apply: (settings: Record<string, unknown> | null) => Record<string, unknown>;
    remove: (settings: Record<string, unknown>) => Record<string, unknown>;
    notice?: string;
  }>;
}): SetupUnit {
  return {
    id: spec.id,
    group: "Other",
    label: spec.label,
    description: spec.description,
    defaultSelected: spec.defaultSelected,

    async inspect(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") return "foreign";
      return (await spec.load()).state(settings);
    },

    async apply(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable") {
        console.warn(
          `Warning: ${ctx.claudeSettingsPath} is not valid JSON — ${spec.label} not applied.`
        );
        return;
      }
      const key = await spec.load();
      if (key.state(settings) !== "absent") return;
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(key.apply(settings), null, 2)}\n`);
      if (key.notice) console.log(`\n${key.notice}`);
    },

    async remove(ctx) {
      const settings = await readClaudeSettings(ctx.claudeSettingsPath);
      if (settings === "unparseable" || settings === null) return;
      const { remove } = await spec.load();
      await Bun.write(ctx.claudeSettingsPath, `${JSON.stringify(remove(settings), null, 2)}\n`);
    },
  };
}

/**
 * The model-routing guidance and the two hook pairs.
 *
 * All three used to share one consent decision — the hooks rode on the answer
 * to the guidance prompt, and the worktree hooks were never asked about at all.
 * They are three units now because they are three choices, and someone who
 * wants the reminder without the section (or the reverse) can now say so.
 */
export function guidanceUnits(): SetupUnit[] {
  return [
    {
      id: "guidance:model-routing",
      group: "Guidance",
      label: "Model-routing guidance",
      description: "which tier to use per task when delegating, written into each host's rules",
      defaultSelected: true,

      async inspect(ctx): Promise<UnitState> {
        const eligible = ctx.installed.filter((r) => r.routing && r.writeModelRouting);
        if (eligible.length === 0) return "unavailable";

        const { ROUTING_CONTENT_VERSION } = await import("../constants.js");
        const versions = await Promise.all(
          eligible.map(async (r) => {
            try {
              return (await r.writtenRoutingVersion?.()) ?? null;
            } catch {
              return null;
            }
          })
        );

        if (versions.every((v) => v === null)) return "absent";
        if (versions.some((v) => v === null || v < ROUTING_CONTENT_VERSION)) return "stale";
        return "current";
      },

      async apply(ctx): Promise<void> {
        const eligible = ctx.installed.filter((r) => r.routing && r.writeModelRouting);
        if (eligible.length === 0) return;

        const { loadRoutingConfig } = await import("../rules/model-routing-config.js");
        const resolved = await loadRoutingConfig(ctx.routingConfigPath);
        for (const warning of resolved.warnings) console.warn(`Warning: ${warning}`);

        const { getModelRoutingSection } = await import("../rules/model-routing.js");
        for (const registrar of eligible) {
          try {
            await registrar.writeModelRouting!(await getModelRoutingSection(registrar, resolved));
          } catch (e: any) {
            console.warn(
              `Warning: Failed to write model-routing guidance for ${registrar.name}: ${e.message}`
            );
          }
        }
      },

      async remove(ctx): Promise<void> {
        const { removeSection } = await import("../rules/section-marker.js");
        const { ROUTING_SECTION_ID } = await import("../registrars/routing-section.js");
        for (const registrar of ctx.installed) {
          const path = registrar.rulesFilePath?.();
          if (path) await removeSection(path, ROUTING_SECTION_ID);
        }
      },
    },

    hookUnit({
      id: "hooks:routing",
      label: "Routing hooks",
      description: "SessionStart reminder of the routing rules (Claude Code only)",
      probe: "project-brain routing-rules",
      strictOf: (ctx) => ctx.hookStrict.routing,
      load: async () => {
        const m = await import("../hooks/claude-settings.js");
        return { upsert: m.upsertRoutingHooks, remove: m.removeRoutingHooks };
      },
    }),

    hookUnit({
      id: "hooks:worktree",
      label: "Worktree hooks",
      description: "worktree identity on session start, index cleanup on removal",
      probe: "project-brain worktree-hook session",
      strictOf: (ctx) => ctx.hookStrict.worktree,
      load: async () => {
        const m = await import("../hooks/claude-settings.js");
        return { upsert: m.upsertWorktreeHooks, remove: m.removeWorktreeHooks };
      },
    }),

    hookUnit({
      id: "hooks:session-title",
      label: "Session title hook",
      description: "name and colour the session after the work, once the agent picks them",
      probe: "project-brain session-title apply",
      strictOf: () => false,
      load: async () => {
        const m = await import("../hooks/claude-settings.js");
        return { upsert: m.upsertSessionTitleHook, remove: m.removeSessionTitleHook };
      },
    }),
  ];
}

/**
 * The two units that belong to no other group.
 *
 * `embed:ollama-model` is the one unit whose `remove` does nothing, and that is
 * deliberate rather than unfinished: an Ollama model is global to the machine
 * and shared with every other tool on it. Deselecting means "stop pulling it",
 * and the confirm screen says so instead of implying a delete we would be wrong
 * to perform.
 */
export function otherUnits(): SetupUnit[] {
  return [
    {
      id: "embed:ollama-model",
      group: "Other",
      label: "Ollama model",
      description: "pulls nomic-embed-text; never deleted on removal, it is shared machine-wide",
      defaultSelected: true,

      async inspect(ctx): Promise<UnitState> {
        if (ctx.skipOllama) return "unavailable";
        const { detectEnvironment } = await import("../env/detect.js");
        const env = await detectEnvironment();
        if (!env.ollama.available) return "unavailable";
        return env.ollama.models.includes("nomic-embed-text") ? "current" : "absent";
      },

      async apply(ctx): Promise<void> {
        if (ctx.skipOllama) return;
        try {
          const proc = Bun.spawn(["ollama", "pull", "nomic-embed-text"], {
            stdout: "inherit",
            stderr: "inherit",
          });
          await proc.exited;
        } catch {
          console.warn("Warning: Failed to pull Ollama model.");
        }
      },

      async remove(): Promise<void> {
        // Intentionally empty. See the unit's description.
      },
    },
    {
      id: "config:record-connection",
      group: "Other",
      label: "brain-record config",
      description: "which Chrome brain-record drives, and on which CDP port",
      defaultSelected: true,

      async inspect(ctx): Promise<UnitState> {
        try {
          const parsed = JSON.parse(await Bun.file(ctx.recordConfigPath).text());
          return parsed.mode === ctx.recordConnection.mode &&
            parsed.cdpPort === ctx.recordConnection.cdpPort
            ? "current"
            : "stale";
        } catch {
          return "absent";
        }
      },

      async apply(ctx): Promise<void> {
        const { mkdir } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(ctx.recordConfigPath), { recursive: true });
        await Bun.write(
          ctx.recordConfigPath,
          `${JSON.stringify(ctx.recordConnection, null, 2)}\n`
        );
      },

      async remove(ctx): Promise<void> {
        const { rm } = await import("node:fs/promises");
        await rm(ctx.recordConfigPath, { force: true });
      },
    },
    {
      id: "config:reranker",
      group: "Other",
      label: "Jev reranker",
      description:
        "reorders search results with TypeSafe's Jev model — sends the query and candidate code/doc snippets to api.typesafe.ai",
      // Ships unchecked: unlike every other unit here, this one sends the
      // content of every search — the query AND candidate code/doc snippets —
      // to a third-party API. That is a real disclosure decision, not a
      // convenience default.
      defaultSelected: false,

      async inspect(ctx): Promise<UnitState> {
        const { resolveRerankerToken } = await import("../rerank/token.js");
        const token = await resolveRerankerToken({ dataDir: ctx.dataDir });
        return token ? "current" : "absent";
      },

      async apply(ctx): Promise<void> {
        const { writeRerankerToken } = await import("../rerank/token.js");

        let token = ctx.rerankerToken ?? process.env.TYPESAFE_API_KEY;
        if (!token) {
          const prompt =
            ctx.promptRerankerToken ?? (await import("../interactive.js")).promptRerankerToken;
          token = (await prompt()) ?? undefined;
        }
        if (!token) {
          throw new Error(
            "Jev reranker requires a token: pass --reranker-token <token>, set TYPESAFE_API_KEY, " +
              "or run setup interactively to be prompted."
          );
        }

        await writeRerankerToken(ctx.dataDir, token);
      },

      async remove(ctx): Promise<void> {
        const { removeRerankerToken } = await import("../rerank/token.js");
        await removeRerankerToken(ctx.dataDir);
      },
    },
    settingsKeyUnit({
      id: "config:auto-compact",
      label: "Auto-compact at 400K",
      description:
        "compacts long Claude Code sessions near 400K tokens instead of 967K to spend less of the plan; `claude --autocompact 1000000` restores the full window for one session",
      defaultSelected: true,
      load: async () => {
        const m = await import("./auto-compact.js");
        return {
          state: m.autoCompactState,
          apply: m.withAutoCompact,
          remove: m.withoutAutoCompact,
          notice:
            `Auto-compact: sessions now compact near 400K tokens. For a task that needs the ` +
            `whole window, start it with:\n  ${m.FULL_WINDOW_HINT}`,
        };
      },
    }),
    settingsKeyUnit({
      id: "config:no-commit-attribution",
      label: "No commit attribution",
      description:
        "stops Claude Code appending Co-Authored-By and Claude-Session trailers to commits and PRs",
      // Unchecked: it changes what every commit and PR says, in every repo on
      // the machine, and some teams want the trailer. That is theirs to decide.
      defaultSelected: false,
      load: async () => {
        const m = await import("./commit-attribution.js");
        return {
          state: m.attributionState,
          apply: m.withoutAttribution,
          remove: m.withAttributionRestored,
        };
      },
    }),
    {
      id: "config:chrome-autoconnect",
      group: "Other",
      label: "chrome-devtools autoConnect",
      description:
        "browser tools drive your logged-in Chrome instead of a fresh profile; needs the chrome://inspect toggle, and costs one growing attachment per open session",

      // The only unit that ships unchecked. Every other one installs something
      // of ours; this one hands an MCP server full control of the browser the
      // user is signed into, and a default-on checkbox is how someone ends up
      // consenting to that without reading the row.
      defaultSelected: false,

      async inspect(ctx): Promise<UnitState> {
        const { entryAutoConnectState } = await import("./chrome-autoconnect.js");
        const states = (await chromeDevtoolsEntries(ctx)).map(([, entry]) =>
          entryAutoConnectState(entry)
        );
        const actionable = states.filter((s) => s !== "unsupported");

        // No entry left to edit. When a shared service runs the server instead,
        // the flag lives in that service's command, so answer from there rather
        // than claiming the machine cannot do it.
        if (actionable.length === 0) {
          const service = await findSharedChromeService(ctx);
          if (!service) return "unavailable";
          return entryAutoConnectState({ args: service.chromeArgs }) === "present"
            ? "current"
            : "foreign";
        }
        return actionable.every((s) => s === "present") ? "current" : "absent";
      },

      async apply(ctx): Promise<void> {
        const {
          entryAutoConnectState,
          addAutoConnect,
          TOGGLE_URL,
          REMOTE_DEBUGGING_WARNING,
          ATTACHMENT_COST_NOTE,
        } = await import("./chrome-autoconnect.js");
        const { upsertJsonConfig } = await import("../registrars/json-config.js");

        let changed = false;
        for (const { path, containerKey, names } of await chromeDevtoolsTargets(ctx)) {
          if (names.length === 0) continue;
          await upsertJsonConfig(path, (config) => {
            for (const name of names) {
              const entry = config[containerKey]?.[name];
              if (entry && entryAutoConnectState(entry) === "missing") {
                addAutoConnect(entry);
                changed = true;
              }
            }
          });
        }

        // The flag is half of it. Chrome refuses the connection until the user
        // flips the toggle themselves, so saying so here is not a nicety — it
        // is the difference between a working setup and a silent failure later.
        // The cost note rides along for the same reason: it is discovered as a
        // multi-gigabyte process weeks later unless it is said here.
        if (changed) {
          console.log(
            `\nchrome-devtools autoConnect: open ${TOGGLE_URL} in your Chrome and turn on ` +
              `"Allow remote debugging for this browser instance", then reconnect the MCP server.\n` +
              `${REMOTE_DEBUGGING_WARNING}\n${ATTACHMENT_COST_NOTE}`
          );
        }
      },

      async remove(ctx): Promise<void> {
        const { removeAutoConnect } = await import("./chrome-autoconnect.js");
        const { upsertJsonConfig } = await import("../registrars/json-config.js");

        for (const { path, containerKey, names } of await chromeDevtoolsTargets(ctx)) {
          if (names.length === 0) continue;
          await upsertJsonConfig(path, (config) => {
            for (const name of names) {
              const entry = config[containerKey]?.[name];
              if (entry) removeAutoConnect(entry);
            }
          });
        }
      },
    },
    {
      id: "service:chrome-shared-server",
      group: "Other",
      label: "chrome-devtools shared server",
      description:
        "one chrome-devtools MCP process for every session instead of one per session; installs a login service",

      // Unchecked for the same reason as autoConnect, plus one of its own: this
      // is the only unit that installs an OS service and a Python tool. Both
      // are answers a person should give on purpose.
      defaultSelected: false,

      async inspect(ctx): Promise<UnitState> {
        const { serviceKindFor } = await import("./chrome-shared-server.js");
        if (!serviceKindFor(process.platform)) return "unavailable";

        // A replaced entry is an http entry, so it no longer answers to
        // `isChromeDevtoolsEntry` — anything still listed here is a session
        // that would keep spawning its own server.
        const stillSpawning = (await chromeDevtoolsEntries(ctx)).length > 0;

        const service = await findSharedChromeService(ctx);
        // A bridge installed by hand does the same job under another label. It
        // is theirs: reported so, and never uninstalled from here.
        if (service && !service.ours) return "foreign";

        if (service) {
          // The service is up but some host was never moved across, so the
          // machine is paying for both arrangements at once.
          return stillSpawning ? "stale" : "current";
        }

        // Nothing to move means nothing to offer: this unit only ever converts
        // an arrangement that already exists.
        return stillSpawning ? "absent" : "unavailable";
      },

      async apply(ctx): Promise<void> {
        const mod = await import("./chrome-shared-server.js");
        const { upsertJsonConfig } = await import("../registrars/json-config.js");
        const kind = mod.serviceKindFor(process.platform);
        if (!kind) return;

        const bridgeBin = await ensureBridge();
        if (!bridgeBin) {
          console.warn(
            `Warning: ${mod.BRIDGE_PACKAGE} is not installed and uv is not available to ` +
              `install it. Skipping the shared chrome-devtools server.`
          );
          return;
        }

        // The command to share is the one the host already runs. Taking it
        // verbatim means every flag the user already answered for — including
        // autoConnect — moves across without this unit deciding any of them.
        const targets = await chromeDevtoolsTargets(ctx);
        const source = targets.flatMap((t) => t.entries).find((e) => Array.isArray(e?.args));
        if (!source) return;

        const resolved = Bun.which(source.command) ?? source.command;
        const warning = mod.ephemeralPathWarning(resolved);
        if (warning) {
          console.warn(`Warning: ${warning}`);
          return;
        }

        const port = await sharedServerPort(ctx);
        const spec = {
          port,
          bridgeBin,
          command: [resolved, ...source.args],
          logPath: `${ctx.dataDir}/chrome-devtools-shared.log`,
          path: servicePath(bridgeBin, resolved),
        };

        await installSharedService(kind, spec, mod);

        // Remember what each entry was, so removal restores it rather than
        // guessing a command back into existence.
        const before: Record<string, Record<string, any>> = {};
        for (const { path, containerKey, names } of targets) {
          if (names.length === 0) continue;
          before[path] = {};
          await upsertJsonConfig(path, (config) => {
            for (const name of names) {
              before[path][name] = config[containerKey][name];
              config[containerKey][name] = mod.sharedEntry(port);
            }
          });
        }
        await Bun.write(
          `${ctx.dataDir}/chrome-shared-server.json`,
          `${JSON.stringify({ port, before }, null, 2)}\n`
        );

        console.log(
          `\nchrome-devtools shared server: one process now serves every session at ` +
            `${mod.sharedUrl(port)}. Nothing bounds how large it grows, so restart it ` +
            `between long stretches of browser work:\n  ${mod.restartCommand(kind)}`
        );
      },

      async remove(ctx): Promise<void> {
        const mod = await import("./chrome-shared-server.js");
        const { upsertJsonConfig } = await import("../registrars/json-config.js");
        const { rm } = await import("node:fs/promises");
        const kind = mod.serviceKindFor(process.platform);
        if (!kind) return;

        await uninstallSharedService(kind);

        const statePath = `${ctx.dataDir}/chrome-shared-server.json`;
        let state: { before?: Record<string, Record<string, any>> } = {};
        try {
          state = JSON.parse(await Bun.file(statePath).text());
        } catch {
          // No record of what was there. The service is gone either way, and
          // inventing an stdio entry would be worse than leaving the URL.
          return;
        }

        for (const [path, entries] of Object.entries(state.before ?? {})) {
          await upsertJsonConfig(path, (config) => {
            for (const [name, entry] of Object.entries(entries)) {
              const container = Object.keys(config).find((k) => config[k]?.[name]);
              if (container) config[container][name] = entry;
            }
          });
        }
        await rm(statePath, { force: true });
      },
    },
  ];
}

/** The port the bridge listens on, from the recorded state or the default. */
async function sharedServerPort(ctx: SetupContext): Promise<number> {
  const { DEFAULT_PORT } = await import("./chrome-shared-server.js");
  try {
    const state = JSON.parse(await Bun.file(`${ctx.dataDir}/chrome-shared-server.json`).text());
    return typeof state.port === "number" ? state.port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * `mcp-proxy` on PATH, installing it with uv if it is missing.
 *
 * uv puts tools in ~/.local/bin, which is not always on the PATH of the shell
 * that ran setup, so the freshly installed binary is looked for there too
 * rather than reported as a failed install.
 */
async function ensureBridge(): Promise<string | null> {
  const { bridgeInstallArgs, BRIDGE_PACKAGE } = await import("./chrome-shared-server.js");

  const found = Bun.which(BRIDGE_PACKAGE);
  if (found) return found;

  if (!Bun.which("uv")) return null;
  const proc = Bun.spawn(["uv", ...bridgeInstallArgs()], { stdout: "inherit", stderr: "inherit" });
  await proc.exited;

  const fallback = `${process.env.HOME}/.local/bin/${BRIDGE_PACKAGE}`;
  return Bun.which(BRIDGE_PACKAGE) ?? ((await Bun.file(fallback).exists()) ? fallback : null);
}

/** A PATH a login service can actually run with: it inherits almost nothing. */
function servicePath(...bins: string[]): string {
  const dirs = bins.map((b) => b.slice(0, b.lastIndexOf("/"))).filter(Boolean);
  return [...new Set([...dirs, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(
    ":"
  );
}

function serviceDir(kind: "launchd" | "systemd", ctx?: SetupContext): string {
  if (ctx?.serviceDir) return ctx.serviceDir;
  return kind === "launchd"
    ? `${process.env.HOME}/Library/LaunchAgents`
    : `${process.env.HOME}/.config/systemd/user`;
}

async function sharedServiceFile(
  kind: "launchd" | "systemd",
  ctx?: SetupContext
): Promise<string> {
  const { SERVICE_LABEL } = await import("./chrome-shared-server.js");
  return `${serviceDir(kind, ctx)}/${SERVICE_LABEL}.${kind === "launchd" ? "plist" : "service"}`;
}

/**
 * The per-user service that runs chrome-devtools-mcp, ours or anyone's.
 *
 * Ours is checked first, so a machine carrying both reports the one this unit
 * can manage. A definition we cannot parse is skipped, not guessed at.
 */
async function findSharedChromeService(
  ctx: SetupContext
): Promise<{ file: string; ours: boolean; chromeArgs: string[] } | null> {
  const { serviceKindFor, serviceArgv, servedChromeArgs } = await import(
    "./chrome-shared-server.js"
  );
  const kind = serviceKindFor(process.platform);
  if (!kind) return null;

  const { readdir } = await import("node:fs/promises");
  const dir = serviceDir(kind, ctx);
  const ours = await sharedServiceFile(kind, ctx);
  const ext = kind === "launchd" ? ".plist" : ".service";

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(ext));
  } catch {
    return null;
  }
  const files = names.map((n) => `${dir}/${n}`).sort((a, b) => Number(b === ours) - Number(a === ours));

  for (const file of files) {
    let text: string;
    try {
      text = await Bun.file(file).text();
    } catch {
      continue;
    }
    const argv = serviceArgv(kind, text);
    const chromeArgs = argv ? servedChromeArgs(argv) : null;
    if (!chromeArgs) continue;

    // A service no host points at is not what any session uses — it may be a
    // leftover, or somebody else's — so it answers nothing about this setup.
    const port = argv![argv!.indexOf("--port") + 1];
    if (port && (await hostsPointAt(ctx, port))) {
      return { file, ours: file === ours, chromeArgs };
    }
  }
  return null;
}

/** True when some detected host has an MCP entry whose URL is on `port`. */
async function hostsPointAt(ctx: SetupContext, port: string): Promise<boolean> {
  for (const registrar of ctx.installed) {
    const target = registrar.mcpConfigTarget?.();
    if (!target) continue;
    try {
      const config = JSON.parse(await Bun.file(target.path).text());
      const entries = Object.values(config?.[target.containerKey] ?? {}) as any[];
      if (entries.some((e) => typeof e?.url === "string" && e.url.includes(`:${port}/`))) {
        return true;
      }
    } catch {
      // Absent or unparseable: no evidence either way, so no evidence.
    }
  }
  return false;
}

async function installSharedService(
  kind: "launchd" | "systemd",
  spec: any,
  mod: typeof import("./chrome-shared-server.js")
): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const file = await sharedServiceFile(kind);
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await Bun.write(file, kind === "launchd" ? mod.launchdPlist(spec) : mod.systemdUnit(spec));

  const uid = process.getuid?.() ?? 0;
  const cmds =
    kind === "launchd"
      ? [
          ["launchctl", "bootout", `gui/${uid}/${mod.SERVICE_LABEL}`],
          ["launchctl", "bootstrap", `gui/${uid}`, file],
        ]
      : [
          ["systemctl", "--user", "daemon-reload"],
          ["systemctl", "--user", "enable", "--now", `${mod.SERVICE_LABEL}.service`],
        ];

  for (const cmd of cmds) {
    // `bootout` fails when nothing is loaded yet, which is the normal first
    // install — the bootstrap that follows is the one whose result matters.
    try {
      await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
    } catch {
      /* reported by the bootstrap/enable that follows */
    }
  }
}

async function uninstallSharedService(kind: "launchd" | "systemd"): Promise<void> {
  const { SERVICE_LABEL } = await import("./chrome-shared-server.js");
  const { rm } = await import("node:fs/promises");
  const uid = process.getuid?.() ?? 0;

  const cmd =
    kind === "launchd"
      ? ["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]
      : ["systemctl", "--user", "disable", "--now", `${SERVICE_LABEL}.service`];

  try {
    await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    /* already gone */
  }
  await rm(await sharedServiceFile(kind), { force: true });
}

/**
 * Every chrome-devtools MCP entry across the detected hosts' JSON configs.
 *
 * A host with no `mcpConfigTarget` (Codex, whose server map is TOML that only
 * its own CLI may rewrite) is skipped rather than guessed at, and an absent or
 * unparseable config yields nothing instead of throwing: this runs during
 * `inspect`, where the honest answer to "can't read it" is "nothing to offer".
 */
async function chromeDevtoolsTargets(
  ctx: SetupContext
): Promise<Array<{ path: string; containerKey: string; names: string[]; entries: any[] }>> {
  const { findChromeDevtoolsEntries } = await import("./chrome-autoconnect.js");
  const targets = [];

  for (const registrar of ctx.installed) {
    const target = registrar.mcpConfigTarget?.();
    if (!target) continue;

    let config: Record<string, any>;
    try {
      config = JSON.parse(await Bun.file(target.path).text());
    } catch {
      continue;
    }

    const found = findChromeDevtoolsEntries(config, target.containerKey);
    targets.push({
      path: target.path,
      containerKey: target.containerKey,
      names: found.map(([name]) => name),
      entries: found.map(([, entry]) => entry),
    });
  }

  return targets;
}

/** The [name, entry] pairs alone, for the states `inspect` reports on. */
async function chromeDevtoolsEntries(ctx: SetupContext): Promise<Array<[string, any]>> {
  const targets = await chromeDevtoolsTargets(ctx);
  return targets.flatMap((t) => t.names.map((name, i) => [name, t.entries[i]] as [string, any]));
}

/**
 * Every unit setup can offer, in display order.
 *
 * Hosts come first because everything below them depends on a host existing:
 * a skills root comes from a detected tool, and both hook units are Claude
 * Code's.
 */
export function allUnits(ctx: SetupContext): SetupUnit[] {
  return [...hostUnits(ctx.installed), ...guidanceUnits(), ...skillUnits(), ...otherUnits()];
}
