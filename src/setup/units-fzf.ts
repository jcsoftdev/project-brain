import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SetupContext, SetupUnit, UnitState } from "./units.js";
import type { FzfThemeTarget, Which } from "./fzf-theme.js";

export interface FzfThemeUnitDeps {
  which?: Which;
  shell?: string;
}

async function targetOf(ctx: SetupContext, deps: FzfThemeUnitDeps): Promise<FzfThemeTarget> {
  const { fzfRcPath } = await import("./fzf-theme.js");
  const { themeById } = await import("../themes/index.js");
  const home = dirname(dirname(ctx.claudeSettingsPath));
  // ZDOTDIR belongs to the real user: a setup run against another home (a test, a sandbox) never follows it.
  const zdotdir = home === homedir() ? process.env.ZDOTDIR : undefined;
  return {
    rcPath: fzfRcPath(home, deps.shell ?? process.env.SHELL, zdotdir),
    which: deps.which ?? Bun.which,
    theme: themeById(),
  };
}

export function fzfThemeUnit(deps: FzfThemeUnitDeps = {}): SetupUnit {
  return {
    id: "terminal:fzf-theme",
    group: "Terminal tools",
    label: "fzf colour theme",
    description:
      "adds a marked block at the end of your ~/.zshrc (~/.bashrc under bash) that appends the theme's --color to FZF_DEFAULT_OPTS, so your own options stay: transparent background, current row on a soft raised line, cyan matches, orange prompt, pink pointer; " +
      "needs fzf; untick to delete only the block",
    defaultSelected: false,

    async inspect(ctx): Promise<UnitState> {
      const { fzfThemeState } = await import("./fzf-theme.js");
      return fzfThemeState(await targetOf(ctx, deps));
    },

    async apply(ctx): Promise<void> {
      const { applyFzfTheme } = await import("./fzf-theme.js");
      await applyFzfTheme(await targetOf(ctx, deps));
    },

    async remove(ctx): Promise<void> {
      const { removeFzfTheme } = await import("./fzf-theme.js");
      await removeFzfTheme(await targetOf(ctx, deps));
    },
  };
}
