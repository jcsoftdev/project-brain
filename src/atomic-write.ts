import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes `data` to `file` via a temp file in the same directory and a rename,
 * so a reader (or a crash mid-write) sees the old file or the new one, never a
 * truncated one. Keeps the mode of an existing target (a 0600 file stays 0600). Creates the directory. Throws on failure; callers decide
 * whether a lost cache write matters.
 *
 * `beforeRename` runs after the temp file is complete and immediately before the
 * rename; returning false abandons the write (the temp file is removed) and the
 * function resolves to false.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { beforeRename?: () => boolean | Promise<boolean> } = {}
): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, data);
    const mode = await stat(file).then((st) => st.mode & 0o777, () => null);
    if (mode !== null) await chmod(tmp, mode);
    if (opts.beforeRename && !(await opts.beforeRename())) {
      await rm(tmp, { force: true });
      return false;
    }
    await rename(tmp, file);
    return true;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
