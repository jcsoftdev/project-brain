import { dirname } from "node:path";
import { mkdir, stat } from "node:fs/promises";

/** Windows-safe directory check (no POSIX `test` binary — review finding). */
export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Read-or-init a JSON config, apply a mutation, write it back (pretty, 2-space). */
export async function upsertJsonConfig(
  configPath: string,
  mutate: (config: Record<string, any>) => void
): Promise<void> {
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(await Bun.file(configPath).text());
  } catch {
    // absent or invalid → start fresh
  }
  mutate(config);
  await mkdir(dirname(configPath), { recursive: true });
  await Bun.write(configPath, JSON.stringify(config, null, 2));
}

/** The standard mcpServers entry every JSON-config registrar writes. */
export function standardServerEntry(serverPath: string): Record<string, unknown> {
  return { command: "bun", args: [serverPath], transport: "stdio" };
}
