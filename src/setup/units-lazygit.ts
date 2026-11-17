import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SetupContext, SetupUnit, UnitState } from "./units.js";

export interface LazygitUnitDeps {
  which?: (bin: string) => string | null;
  /** Prints lazygit's config directory; defaults to `lazygit --print-config-dir`. */
  printConfigDir?: (lazygitBin: string) => string | null;
}

function printConfigDirOf(lazygitBin: string): string | null {
  const result = Bun.spawnSync([lazygitBin, "--print-config-dir"], { stdout: "pipe", stderr: "ignore" });
  const dir = result.stdout.toString().trim();
  return result.exitCode === 0 && dir.startsWith("/") ? dir : null;
}

async function pathsOf(ctx: SetupContext, deps: Required<LazygitUnitDeps>) {
  const { lazygitConfigDir, lazygitOwnerConfigFiles, LAZYGIT_THEME_FILENAME } = await import("./lazygit-theme.js");
  const home = dirname(dirname(ctx.claudeSettingsPath));
  const fallbackDir = lazygitConfigDir(home, ctx.platform ?? process.platform, undefined);
  // The environment and the binary's own answer belong to the real user: a setup run against another home never follows them.
  const isRealHome = home === homedir();
  const bin = isRealHome ? deps.which("lazygit") : null;
  const configDir = (bin && deps.printConfigDir(bin)) || fallbackDir;
  return {
    themeFile: join(home, LAZYGIT_THEME_FILENAME),
    ownerConfigFiles: lazygitOwnerConfigFiles(configDir, isRealHome ? process.env.LG_CONFIG_FILE : undefined),
  };
}

export function lazygitThemeUnit(options: LazygitUnitDeps = {}): SetupUnit {
  const deps: Required<LazygitUnitDeps> = {
    which: options.which ?? ((bin) => Bun.which(bin)),
    printConfigDir: options.printConfigDir ?? printConfigDirOf,
  };
  return {
    id: "terminal:lazygit-theme",
    group: "Terminal tools",
    label: "lazygit colour theme",
    description:
      "writes ~/.lazygit.yml, which lazygit merges over its config in every repository under your home: purple frame on the focused panel, orange while you type a filter, the current row on a quiet bar that keeps red and green readable; " +
      "your config.yml is never touched, and a theme you already set there is left alone; untick to delete the file",
    defaultSelected: false,

    async inspect(ctx): Promise<UnitState> {
      if (!deps.which("lazygit")) return "unavailable";
      const { lazygitThemeState } = await import("./lazygit-theme.js");
      const { themeById } = await import("../themes/index.js");
      return lazygitThemeState(await pathsOf(ctx, deps), themeById());
    },

    async apply(ctx): Promise<void> {
      if (!deps.which("lazygit")) return;
      const { applyLazygitTheme } = await import("./lazygit-theme.js");
      const { themeById } = await import("../themes/index.js");
      await applyLazygitTheme(await pathsOf(ctx, deps), themeById());
    },

    async remove(ctx): Promise<void> {
      const { removeLazygitTheme } = await import("./lazygit-theme.js");
      await removeLazygitTheme(await pathsOf(ctx, deps));
    },
  };
}
