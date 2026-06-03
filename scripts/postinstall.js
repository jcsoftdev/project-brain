#!/usr/bin/env node
import { createWriteStream, mkdirSync, chmodSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { get } from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await import("fs").then((fs) =>
    fs.promises.readFile(join(__dirname, "../package.json"), "utf-8")
  )
);

const VERSION = pkg.version;
const REPO = "jcsoftdev/project-brain";

const platform = process.platform; // darwin, linux, win32
const arch = process.arch; // arm64, x64

const targetMap = {
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
  "win32-arm64": "windows-arm64",
};

const key = `${platform}-${arch}`;
const target = targetMap[key];

if (!target) {
  console.error(`project-brain: unsupported platform ${key}. Skipping binary download.`);
  process.exit(0);
}

const ext = platform === "win32" ? ".exe" : "";
const binaryName = `project-brain-${target}${ext}`;
const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${binaryName}`;
const destDir = join(__dirname, "../bin");
const destPath = join(destDir, `project-brain-native${ext}`);

if (existsSync(destPath)) {
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

console.log(`project-brain: downloading binary for ${key}...`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (u) =>
      get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      }).on("error", reject);
    request(url);
  });
}

try {
  await download(url, destPath);
  chmodSync(destPath, 0o755);
  console.log(`project-brain: binary installed.`);
} catch (err) {
  console.error(`project-brain: failed to download binary — ${err.message}`);
  console.error(`project-brain: manual download: ${url}`);
  process.exit(0);
}
