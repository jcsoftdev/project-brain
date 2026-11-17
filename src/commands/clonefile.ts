import { dlopen, FFIType } from "bun:ffi";

type CloneFile = (source: Buffer, target: Buffer, flags: number) => number;

let clonefile: CloneFile | null | undefined;

function load(): CloneFile | null {
  if (clonefile !== undefined) return clonefile;
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    clonefile = lib.symbols.clonefile as unknown as CloneFile;
  } catch {
    clonefile = null;
  }
  return clonefile;
}

/**
 * Clone a whole directory tree with one `clonefile(2)` call (APFS only).
 *
 * `cp -c -R` clones file by file, one syscall each, which is ~10 s for the 53 000 entries of a
 * pnpm `node_modules`; cloning the directory itself is atomic and took ~0.7 s on the same tree.
 * Returns false whenever the call is unavailable or refuses (not APFS, target exists, another
 * volume), and the caller falls back to `cp`. Nothing is left behind on failure: the clone is
 * all-or-nothing.
 */
export function cloneTree(source: string, target: string): boolean {
  if (process.platform !== "darwin") return false;
  const call = load();
  if (!call) return false;
  try {
    return call(Buffer.from(`${source}\0`), Buffer.from(`${target}\0`), 0) === 0;
  } catch {
    return false;
  }
}
