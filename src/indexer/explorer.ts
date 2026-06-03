/**
 * List tracked project files using git ls-files.
 * Returns array of relative paths.
 */
export async function listFiles(root: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `Not a git repository or git command failed: ${stderr.trim()}`
    );
  }

  const stdout = await new Response(proc.stdout).text();
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
