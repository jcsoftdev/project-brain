import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SetupContext, SetupUnit, UnitState } from "./units.js";
import type { BatPaths, RebuildCache } from "./bat-theme.js";

export type Which = (command: string) => string | null;
/** The installed bat's version (`0.26.1`), or null when it cannot be told. */
export type BatVersionOf = (bin: string) => string | null;

const BAT_COMMANDS = ["bat", "batcat"] as const;

const batBinOf = (which: Which): string | null =>
  BAT_COMMANDS.map((command) => which(command)).find((path): path is string => path !== null) ?? null;

async function batPathsOf(ctx: SetupContext): Promise<BatPaths> {
  const { batPaths } = await import("./bat-theme.js");
  const home = dirname(dirname(ctx.claudeSettingsPath));
  return batPaths(home, home === homedir() ? process.env : {});
}

async function spawnQuietly(argv: string[]): Promise<number> {
  try {
    return await Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    return -1;
  }
}

function installedBatVersion(bin: string): string | null {
  try {
    const result = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? (/^\S+\s+(\d\S*)/.exec(result.stdout.toString().trim())?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

async function runBat(ctx: SetupContext, argv: string[], failure: string): Promise<void> {
  const code = await (ctx.runService ?? spawnQuietly)(argv);
  if (code !== 0) throw new Error(`\`${argv.join(" ")}\` exited with ${code}; ${failure}`);
}

async function cacheRebuilderOf(ctx: SetupContext, bin: string | null, paths: BatPaths): Promise<RebuildCache> {
  const { batCacheBuildArgv } = await import("./bat-theme.js");
  return async () => {
    if (bin !== null) await runBat(ctx, batCacheBuildArgv(bin, paths), "bat's theme cache was not rebuilt");
  };
}

async function cacheClearerOf(ctx: SetupContext, bin: string | null, paths: BatPaths): Promise<RebuildCache> {
  const { batCacheClearArgv, clearBatCacheFiles } = await import("./bat-theme.js");
  return async () => {
    if (bin === null) await clearBatCacheFiles(paths);
    else await runBat(ctx, batCacheClearArgv(bin, paths), "bat's theme cache was not cleared");
  };
}

export function batThemeUnit(which: Which = (command) => Bun.which(command), versionOf: BatVersionOf = installedBatVersion): SetupUnit {
  return {
    id: "terminal:bat-theme",
    group: "Terminal tools",
    label: "bat colour theme",
    description:
      "writes themes/project-brain-<theme>.tmTheme into bat's config directory and a marked --theme block at the end of its config, then rebuilds bat's cache (bat cache --build): " +
      "the same syntax colours as the Neovim theme; bat's git gutter markers stay its fixed ANSI green/red/yellow; " +
      "after a bat upgrade it shows as stale until the cache is rebuilt for the new bat; " +
      "untick to delete both and clear the cache it built (or rebuild a cache you already had; a theme file of yours at that path is never touched)",
    defaultSelected: false,

    async notice(ctx): Promise<string | null> {
      const themeFromEnv = dirname(dirname(ctx.claudeSettingsPath)) === homedir() ? process.env.BAT_THEME : undefined;
      return themeFromEnv ? `bat: BAT_THEME=${themeFromEnv} is set in your environment and overrides the --theme in bat's config` : null;
    },

    async inspect(ctx): Promise<UnitState> {
      const bin = batBinOf(which);
      const { batThemeState } = await import("./bat-theme.js");
      const { stateWithoutTool } = await import("./managed-block.js");
      const { themeById } = await import("../themes/index.js");
      const paths = await batPathsOf(ctx);
      if (bin === null) return stateWithoutTool(await batThemeState(paths, themeById()));
      return batThemeState(paths, themeById(), versionOf(bin) ?? undefined);
    },

    async apply(ctx): Promise<void> {
      const bin = batBinOf(which);
      if (bin === null) return;
      const { applyBatTheme } = await import("./bat-theme.js");
      const { themeById } = await import("../themes/index.js");
      const paths = await batPathsOf(ctx);
      await applyBatTheme(paths, themeById(), await cacheRebuilderOf(ctx, bin, paths));
    },

    async remove(ctx): Promise<void> {
      const { removeBatTheme } = await import("./bat-theme.js");
      const paths = await batPathsOf(ctx);
      const bin = batBinOf(which);
      await removeBatTheme(paths, await cacheRebuilderOf(ctx, bin, paths), await cacheClearerOf(ctx, bin, paths));
    },
  };
}
