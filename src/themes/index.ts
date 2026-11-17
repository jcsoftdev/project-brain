import { DRACULA } from "./dracula.js";
import type { ThemeDefinition } from "./types.js";

export type { ThemeDefinition } from "./types.js";
export { blend, lighten } from "./color.js";

/** Every theme setup can paint. A new theme is one more entry here. */
export const THEMES: readonly ThemeDefinition[] = [DRACULA];

export const DEFAULT_THEME_ID = "dracula";

export function themeById(id: string = DEFAULT_THEME_ID): ThemeDefinition {
  const found = THEMES.find((theme) => theme.id === id);
  if (!found) throw new Error(`Unknown theme "${id}". Known: ${THEMES.map((theme) => theme.id).join(", ")}`);
  return found;
}
