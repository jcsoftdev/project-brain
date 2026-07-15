/** Groups changed file paths by the top-level module directory that contains them. */
export function bucketChangedFilesByModule(
  changedFiles: string[],
  modules: string[]
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const module of modules) {
    const prefix = `${module}/`;
    const files = changedFiles.filter((f) => f.startsWith(prefix));
    if (files.length > 0) buckets.set(module, files);
  }
  return buckets;
}
