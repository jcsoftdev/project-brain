import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SetupContext, SetupUnit, UnitState } from "./units.js";
import type { Which } from "./tmux-theme.js";

const tmuxConfigOf = async (ctx: SetupContext): Promise<string> => {
  const { tmuxConfigPath } = await import("./tmux-theme.js");
  const home = dirname(dirname(ctx.claudeSettingsPath));
  // XDG_CONFIG_HOME belongs to the real user: a setup run against another home (a test, a sandbox) never follows it.
  return tmuxConfigPath(home, home === homedir() ? process.env.XDG_CONFIG_HOME : undefined);
};

export function tmuxThemeUnit(which: Which = Bun.which): SetupUnit {
  return {
    id: "terminal:tmux-theme",
    group: "Terminal tools",
    label: "tmux colour theme",
    description:
      "adds a marked block at the end of your tmux config (~/.tmux.conf or ~/.config/tmux/tmux.conf): a transparent status bar, the session and current window as purple pills, readable pane borders with the focused one purple, and Dracula selection and search colours; " +
      "it also sets status-left and the window-status formats, so your own versions of those options are overridden while the block is there; a running tmux is not reloaded; untick to delete only the block",
    defaultSelected: false,

    async inspect(ctx): Promise<UnitState> {
      const { tmuxThemeState } = await import("./tmux-theme.js");
      const { themeById } = await import("../themes/index.js");
      return tmuxThemeState(await tmuxConfigOf(ctx), themeById(), which);
    },

    async apply(ctx): Promise<void> {
      const { applyTmuxTheme, tmuxReloadHint } = await import("./tmux-theme.js");
      const { themeById } = await import("../themes/index.js");
      const path = await tmuxConfigOf(ctx);
      await applyTmuxTheme(path, themeById());
      console.log(tmuxReloadHint(path));
    },

    async remove(ctx): Promise<void> {
      const { removeTmuxTheme } = await import("./tmux-theme.js");
      await removeTmuxTheme(await tmuxConfigOf(ctx));
    },
  };
}
