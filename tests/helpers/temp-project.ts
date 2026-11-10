import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway initialized project outside any git checkout, so a test that serves
 * a project never inherits the identity of the checkout `bun test` runs in.
 */
export async function makeTempProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".project-brain"), { recursive: true });
  await writeFile(
    join(root, ".project-brain", "project.json"),
    JSON.stringify({ projectId: "temp-project", root })
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n");
  return root;
}
