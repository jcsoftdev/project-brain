import { join, basename } from "node:path";
import { readdir } from "node:fs/promises";

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  manifest: string | null;
}

export interface ProjectContext {
  name: string;
  root: string;
  stack: StackInfo;
  files: string[];
  modules: string[];
}

interface ManifestDetector {
  file: string;
  language: string;
  detectFrameworks?: (content: string) => string[];
}

const MANIFEST_DETECTORS: ManifestDetector[] = [
  {
    file: "package.json",
    language: "JavaScript",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      try {
        const pkg = JSON.parse(content);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        if (allDeps.typescript || allDeps["@types/node"]) {
          // Override language detection below
        }
        if (allDeps.react) frameworks.push("React");
        if (allDeps.vue) frameworks.push("Vue");
        if (allDeps.next) frameworks.push("Next.js");
        if (allDeps.nuxt) frameworks.push("Nuxt");
        if (allDeps.svelte) frameworks.push("Svelte");
        if (allDeps.express) frameworks.push("Express");
        if (allDeps.fastify) frameworks.push("Fastify");
        if (allDeps.hono) frameworks.push("Hono");
      } catch {}
      return frameworks;
    },
  },
  { file: "go.mod", language: "Go" },
  { file: "Cargo.toml", language: "Rust" },
  { file: "pyproject.toml", language: "Python" },
  { file: "mix.exs", language: "Elixir" },
  { file: "build.gradle", language: "Java" },
  { file: "build.gradle.kts", language: "Kotlin" },
];

const LOCK_FILE_MAP: Record<string, string> = {
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};

/** Detect the technology stack from manifest files in a directory. */
export async function detectStack(root: string): Promise<StackInfo> {
  const languages: string[] = [];
  const frameworks: string[] = [];
  let packageManager: string | null = null;
  let manifest: string | null = null;

  for (const detector of MANIFEST_DETECTORS) {
    try {
      const content = await Bun.file(join(root, detector.file)).text();
      if (!manifest) manifest = detector.file;

      let lang = detector.language;
      // Special case: TypeScript detection in package.json
      if (detector.file === "package.json") {
        try {
          const pkg = JSON.parse(content);
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.typescript || allDeps["@types/bun"] || allDeps["@types/node"]) {
            lang = "TypeScript";
          }
        } catch {}
      }

      if (!languages.includes(lang)) languages.push(lang);

      if (detector.detectFrameworks) {
        for (const fw of detector.detectFrameworks(content)) {
          if (!frameworks.includes(fw)) frameworks.push(fw);
        }
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  // Detect package manager from lock files
  for (const [lockFile, pm] of Object.entries(LOCK_FILE_MAP)) {
    try {
      await Bun.file(join(root, lockFile)).exists().then((exists) => {
        if (exists) packageManager = pm;
      });
      // Check with stat for binary files like bun.lockb
      if (!packageManager) {
        const file = Bun.file(join(root, lockFile));
        if (await file.exists()) {
          packageManager = pm;
        }
      }
      if (packageManager) break;
    } catch {
      // Skip
    }
  }

  return { languages, frameworks, packageManager, manifest };
}

/** Build full project context from root directory. */
export async function buildProjectContext(root: string): Promise<ProjectContext> {
  const stack = await detectStack(root);

  // Get project name from manifest or directory
  let name = basename(root);
  if (stack.manifest === "package.json") {
    try {
      const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text());
      if (pkg.name) name = pkg.name;
    } catch {}
  }

  // Detect top-level modules (directories)
  const modules: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "build"
      ) {
        modules.push(entry.name);
      }
    }
  } catch {}

  return {
    name,
    root,
    stack,
    files: [], // Populated by explorer
    modules,
  };
}
