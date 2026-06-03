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
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.react) frameworks.push("React");
        if (allDeps.vue) frameworks.push("Vue");
        if (allDeps.next) frameworks.push("Next.js");
        if (allDeps.nuxt) frameworks.push("Nuxt");
        if (allDeps.svelte) frameworks.push("Svelte");
        if (allDeps["@sveltejs/kit"]) frameworks.push("SvelteKit");
        if (allDeps.express) frameworks.push("Express");
        if (allDeps.fastify) frameworks.push("Fastify");
        if (allDeps.hono) frameworks.push("Hono");
        if (allDeps["@nestjs/core"]) frameworks.push("NestJS");
        if (allDeps["@remix-run/node"] || allDeps["@remix-run/react"]) frameworks.push("Remix");
        if (allDeps["@tanstack/react-router"]) frameworks.push("TanStack Router");
        if (allDeps.astro) frameworks.push("Astro");
        if (allDeps.elysia) frameworks.push("Elysia");
        if (allDeps["react-native"]) frameworks.push("React Native");
        if (allDeps.expo) frameworks.push("Expo");
        if (allDeps["@angular/core"]) frameworks.push("Angular");
        if (allDeps.solid || allDeps["solid-js"]) frameworks.push("SolidJS");
      } catch {}
      return frameworks;
    },
  },
  // Go
  {
    file: "go.mod",
    language: "Go",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("gin-gonic/gin")) frameworks.push("Gin");
      if (content.includes("labstack/echo")) frameworks.push("Echo");
      if (content.includes("gofiber/fiber")) frameworks.push("Fiber");
      if (content.includes("go-chi/chi")) frameworks.push("Chi");
      return frameworks;
    },
  },
  // Rust
  {
    file: "Cargo.toml",
    language: "Rust",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("actix-web")) frameworks.push("Actix");
      if (content.includes("axum")) frameworks.push("Axum");
      if (content.includes("rocket")) frameworks.push("Rocket");
      if (content.includes("tauri")) frameworks.push("Tauri");
      return frameworks;
    },
  },
  // Python
  {
    file: "pyproject.toml",
    language: "Python",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("fastapi")) frameworks.push("FastAPI");
      if (content.includes("django")) frameworks.push("Django");
      if (content.includes("flask")) frameworks.push("Flask");
      if (content.includes("sqlalchemy")) frameworks.push("SQLAlchemy");
      return frameworks;
    },
  },
  {
    file: "requirements.txt",
    language: "Python",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.toLowerCase().includes("fastapi")) frameworks.push("FastAPI");
      if (content.toLowerCase().includes("django")) frameworks.push("Django");
      if (content.toLowerCase().includes("flask")) frameworks.push("Flask");
      return frameworks;
    },
  },
  // Kotlin / KMP
  {
    file: "build.gradle.kts",
    language: "Kotlin",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("kotlin-multiplatform") || content.includes("multiplatform")) frameworks.push("Kotlin Multiplatform");
      if (content.includes("compose")) frameworks.push("Jetpack Compose");
      if (content.includes("ktor")) frameworks.push("Ktor");
      if (content.includes("spring-boot") || content.includes("org.springframework")) frameworks.push("Spring Boot");
      if (content.includes("android")) frameworks.push("Android");
      return frameworks;
    },
  },
  {
    file: "build.gradle",
    language: "Kotlin",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("kotlin-multiplatform") || content.includes("multiplatform")) frameworks.push("Kotlin Multiplatform");
      if (content.includes("compose")) frameworks.push("Jetpack Compose");
      if (content.includes("ktor")) frameworks.push("Ktor");
      if (content.includes("spring-boot") || content.includes("springframework")) frameworks.push("Spring Boot");
      if (content.includes("android")) frameworks.push("Android");
      return frameworks;
    },
  },
  // Java
  {
    file: "pom.xml",
    language: "Java",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("spring-boot")) frameworks.push("Spring Boot");
      if (content.includes("quarkus")) frameworks.push("Quarkus");
      if (content.includes("micronaut")) frameworks.push("Micronaut");
      return frameworks;
    },
  },
  // Swift / iOS
  {
    file: "Package.swift",
    language: "Swift",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("vapor")) frameworks.push("Vapor");
      if (content.includes("hummingbird")) frameworks.push("Hummingbird");
      return frameworks;
    },
  },
  // Dart / Flutter
  {
    file: "pubspec.yaml",
    language: "Dart",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("flutter")) frameworks.push("Flutter");
      return frameworks;
    },
  },
  // C# / .NET (detected via glob scan below, not by fixed filename)
  // Ruby
  { file: "Gemfile", language: "Ruby",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("rails")) frameworks.push("Rails");
      if (content.includes("sinatra")) frameworks.push("Sinatra");
      return frameworks;
    },
  },
  // PHP
  { file: "composer.json", language: "PHP",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("laravel")) frameworks.push("Laravel");
      if (content.includes("symfony")) frameworks.push("Symfony");
      return frameworks;
    },
  },
  // Elixir
  { file: "mix.exs", language: "Elixir",
    detectFrameworks: (content) => {
      const frameworks: string[] = [];
      if (content.includes("phoenix")) frameworks.push("Phoenix");
      return frameworks;
    },
  },
];

const LOCK_FILE_MAP: Record<string, string> = {
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
};

/** Scan one package.json, merge detected language+frameworks into provided arrays. */
async function scanPackageJson(filePath: string, languages: string[], frameworks: string[]): Promise<void> {
  try {
    const content = await Bun.file(filePath).text();
    const pkg = JSON.parse(content);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const lang = (allDeps.typescript || allDeps["@types/bun"] || allDeps["@types/node"]) ? "TypeScript" : "JavaScript";
    if (!languages.includes(lang)) languages.push(lang);
    const detector = MANIFEST_DETECTORS.find((d) => d.file === "package.json");
    if (detector?.detectFrameworks) {
      for (const fw of detector.detectFrameworks(content)) {
        if (!frameworks.includes(fw)) frameworks.push(fw);
      }
    }
  } catch {}
}

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
      if (detector.file === "package.json") {
        try {
          const pkg = JSON.parse(content);
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.typescript || allDeps["@types/bun"] || allDeps["@types/node"]) lang = "TypeScript";
        } catch {}
      }

      if (!languages.includes(lang)) languages.push(lang);
      if (detector.detectFrameworks) {
        for (const fw of detector.detectFrameworks(content)) {
          if (!frameworks.includes(fw)) frameworks.push(fw);
        }
      }
    } catch {}
  }

  // Monorepo: scan workspace sub-packages (apps/*, packages/*, libs/*, services/*)
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const workspaceDirs = ["apps", "packages", "libs", "services", "modules"];
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && workspaceDirs.includes(e.name))
        .flatMap(async (e) => {
          const subs = await readdir(join(root, e.name), { withFileTypes: true }).catch(() => []);
          return Promise.all(
            subs
              .filter((s) => s.isDirectory())
              .map((s) => scanPackageJson(join(root, e.name, s.name, "package.json"), languages, frameworks))
          );
        })
    );
  } catch {}

  // C# / .NET: scan for *.csproj files
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const csproj = entries.find((e) => e.isFile() && e.name.endsWith(".csproj"));
    if (csproj) {
      if (!languages.includes("C#")) languages.push("C#");
      const content = await Bun.file(join(root, csproj.name)).text();
      if (content.includes("Microsoft.AspNetCore") && !frameworks.includes("ASP.NET Core")) frameworks.push("ASP.NET Core");
      if (content.includes("Blazor") && !frameworks.includes("Blazor")) frameworks.push("Blazor");
      if (content.includes("MAUI") && !frameworks.includes(".NET MAUI")) frameworks.push(".NET MAUI");
    }
  } catch {}

  // KMP: check settings.gradle.kts for multiplatform plugin
  try {
    const settings = await Bun.file(join(root, "settings.gradle.kts")).text();
    if ((settings.includes("kotlin-multiplatform") || settings.includes("multiplatform")) && !frameworks.includes("Kotlin Multiplatform")) {
      frameworks.push("Kotlin Multiplatform");
    }
    if (!languages.includes("Kotlin")) languages.push("Kotlin");
  } catch {}

  // Android: check for AndroidManifest.xml
  try {
    const manifest_ = await Bun.file(join(root, "app/src/main/AndroidManifest.xml")).text();
    if (manifest_ && !frameworks.includes("Android")) frameworks.push("Android");
    if (!languages.includes("Kotlin")) languages.push("Kotlin");
  } catch {}

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
