import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writes `data` to `file` via a temp file in the same directory and a rename,
 * so a reader (or a crash mid-write) sees the old file or the new one, never a
 * truncated one. Keeps the mode of an existing target (a 0600 file stays 0600). Creates the directory. Throws on failure; callers decide
 * whether a lost cache write matters.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, data);
    const mode = await stat(file).then((st) => st.mode & 0o777, () => null);
    if (mode !== null) await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
