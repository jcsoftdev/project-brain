import { basename } from "node:path";

/**
 * Derive a project namespace from git remote origin URL.
 * Falls back to the directory basename if no remote is configured.
 */
export async function deriveProjectId(root: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return basename(root);
    }

    const url = (await new Response(proc.stdout).text()).trim();
    return extractRepoName(url);
  } catch {
    return basename(root);
  }
}

/** Extract repository name from a git remote URL. */
function extractRepoName(url: string): string {
  // Remove trailing .git
  let cleaned = url.replace(/\.git$/, "");

  // Handle SSH format: git@github.com:org/repo
  if (cleaned.includes(":") && !cleaned.includes("://")) {
    const afterColon = cleaned.split(":").pop() ?? "";
    const parts = afterColon.split("/");
    return parts[parts.length - 1] || basename(cleaned);
  }

  // Handle HTTPS format: https://github.com/org/repo
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || basename(cleaned);
}
