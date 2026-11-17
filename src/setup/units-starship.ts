import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SetupContext, SetupUnit, UnitState } from "./units.js";
import type { Which } from "./starship-theme.js";

const starshipConfigOf = async (ctx: SetupContext): Promise<string> => {
  const { starshipConfigPath } = await import("./starship-theme.js");
  const home = dirname(dirname(ctx.claudeSettingsPath));
  return starshipConfigPath(home, home === homedir() ? process.env.STARSHIP_CONFIG : undefined);
};

export function starshipThemeUnit(which: Which = Bun.which): SetupUnit {
  return {
    id: "terminal:starship-theme",
    group: "Terminal tools",
    label: "starship colour palette",
    description:
      "adds two marked blocks to your starship.toml (~/.config/starship.toml or $STARSHIP_CONFIG): `palette` at the top and the theme's palette table at the end, so red, green, yellow, cyan, purple and pink become Dracula's and your styles can name roles such as path, muted, progress or git_dirty; " +
      "a `palette` of your own is never touched; needs starship; untick to delete only the two blocks",
    defaultSelected: false,

    async inspect(ctx): Promise<UnitState> {
      const { starshipThemeState } = await import("./starship-theme.js");
      const { themeById } = await import("../themes/index.js");
      return starshipThemeState(await starshipConfigOf(ctx), themeById(), which);
    },

    async apply(ctx): Promise<void> {
      const { applyStarshipTheme } = await import("./starship-theme.js");
      const { themeById } = await import("../themes/index.js");
      await applyStarshipTheme(await starshipConfigOf(ctx), themeById());
    },

    async remove(ctx): Promise<void> {
      const { removeStarshipTheme } = await import("./starship-theme.js");
      await removeStarshipTheme(await starshipConfigOf(ctx));
    },
  };
}
