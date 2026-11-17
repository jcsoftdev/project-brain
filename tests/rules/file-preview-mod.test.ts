import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_DIRS,
  SECRET_NAMES,
  SECRET_PATHS,
  absoluteOf,
  checkContent,
  checkTarget,
  createBoundedCache,
  createFailureMemo,
  createLatest,
  decodeBase64,
  detectPaths,
  editorArgv,
  editorCommand,
  floatExpr,
  headLines,
  isDefaultSocketName,
  isForbiddenRoot,
  isSecretName,
  kindOf,
  looksBinary,
  nvimExprArgv,
  openExpr,
  parseCommand,
  parseReadOnce,
  pickServer,
  privateDirArgv,
  readOnceArgv,
  readOnlyNvimArgv,
  secretInContent,
  shQuote,
  socketDirs,
  splitRoots,
  supacodeTabArgv,
  thumbnailArgv,
  toolTarget,
  vimString,
} from "../../templates/claude-tui/file-preview/hooks/core";

let dir: string;
let root: string;
let outside: string;
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pb-file-preview-")));
  root = join(dir, "project");
  outside = join(dir, "elsewhere");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1\n");
  await writeFile(join(root, ".env.local"), "TOKEN=x\n");
  await writeFile(join(outside, "secret.txt"), "nope\n");
  await symlink(join(outside, "secret.txt"), join(root, "src", "escape.txt"));
  await symlink(join(root, ".env.local"), join(root, "src", "innocent.txt"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Stands in for `$.fs.stat(path, { resolve: true })`: kind of what it leads to, and its realpath. */
const facts = (spelled: string, roots = [root]) => {
  let real: string | undefined;
  let kind: "file" | "dir" | "other" | undefined;
  try {
    lstatSync(spelled);
    real = realpathSync(spelled);
    const stat = statSync(spelled);
    kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  } catch {
    real = undefined;
  }
  return { spelled, real, kind, roots };
};

const sample = (glob: string) => glob.replace(/\*/g, "x");

describe("secret names", () => {
  it("hold every pattern the owner named", () => {
    for (const glob of [".env*", "*.pem", "*.key", "id_rsa*", "credentials*", "*.p12", ".npmrc", ".netrc", ".pypirc", "kubeconfig*", "secrets.*", "*.tfvars", "terraform.tfstate*", ".dev.vars", "*.kdbx", "*.token", "*.asc", "*.ppk", ".htpasswd", ".mcp.json", ".git-credentials", "*.keystore", "*.jks"]) {
      expect(SECRET_NAMES).toContain(glob);
    }
    for (const path of [".docker/config.json", ".git/config", ".claude/settings*.json"]) expect(SECRET_PATHS).toContain(path);
    for (const name of [".ssh", ".gnupg", ".aws", ".kube"]) expect(SECRET_DIRS).toContain(name);
  });

  it.each(SECRET_NAMES.map((glob) => [glob, sample(glob)]))("%s refuses %s, in any case, as a file and as a parent directory", (_glob, name) => {
    expect(isSecretName(`${root}/src/${name}`, [root])).toBe(true);
    expect(isSecretName(`${root}/src/${name.toUpperCase()}`, [root])).toBe(true);
    expect(isSecretName(`${root}/${name}/notes.md`, [root])).toBe(true);
  });

  it.each(SECRET_PATHS.map((glob) => [glob, sample(glob)]))("%s refuses %s", (_glob, path) => {
    expect(isSecretName(`${root}/${path}`, [root])).toBe(true);
    expect(isSecretName(`${root}/sub/${path}`, [root])).toBe(true);
  });

  it.each(SECRET_DIRS.map((name) => [name]))("everything under %s is refused", (name) => {
    expect(isSecretName(`${root}/${name}/config`, [root])).toBe(true);
    expect(isSecretName(`${root}/${name}/deep/any.txt`, [root])).toBe(true);
  });

  it.each(["src/env.ts", "keyboard.ts", "README.md", "environment.md", "src/config.json", ".github/config.yml", "docker/config.json", "settings.json"])("lets %s through", (path) => {
    expect(isSecretName(`${root}/${path}`, [root])).toBe(false);
  });

  it("judges only the components under the root, so a root's own name never refuses everything", () => {
    const oddRoot = join(dir, "secrets.d");
    expect(isSecretName(`${oddRoot}/src/a.ts`, [oddRoot])).toBe(false);
  });
});

describe("secret content", () => {
  it.each([
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "a private key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key"],
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "a private key"],
    ["PuTTY-User-Key-File-3: ssh-ed25519", "a PuTTY key"],
    ["aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "an AWS access key id"],
    [`token: ghp_${"a1".repeat(18)}`, "a GitHub token"],
    [`github_pat_${"A1b2".repeat(6)}`, "a GitHub token"],
    [`key sk-ant-${"x9".repeat(15)}`, "an API key (sk-)"],
    [`OPENAI=sk-${"Ab1".repeat(10)}`, "an API key (sk-)"],
    ["xoxb-1234567890-abcdef", "a Slack token"],
    [`AIza${"B".repeat(35)}`, "a Google API key"],
    [`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"s".repeat(20)}`, "a JWT"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "a password or token assignment"],
    [`"password": "hunter2hunter2hunter2"`, "a password or token assignment"],
    ["API_KEY=0123456789abcdef0123", "a password or token assignment"],
  ])("refuses %s", (text, label) => {
    expect(secretInContent(`line one\n${text}\nline three`)).toBe(label);
  });

  it.each([
    "-----BEGIN CERTIFICATE-----",
    "const token = await fetchToken()",
    "token: process.env.GITHUB_TOKEN_VALUE",
    "password = getPasswordFromVault(name)",
    "Read the secret docs at docs/secret-handling.md",
  ])("lets ordinary code through: %s", (text) => {
    expect(secretInContent(text)).toBeUndefined();
  });

  it("scans every byte that will be shown, past the first 8 KiB (F1)", () => {
    const text = `${"x".repeat(9000)}\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n`;
    const verdict = checkContent(new TextEncoder().encode(text), (bytes) => new TextDecoder().decode(bytes));
    expect(verdict).toEqual({ ok: false, reason: "it holds what looks like a private key" });
    expect(JSON.stringify(verdict)).not.toContain("BEGIN");
  });

  it("refuses binaries by a NUL anywhere, and stays fast on a long hostile line", () => {
    expect(checkContent(new Uint8Array([0x61, 0x00, 0x62]), () => "a\u0000b")).toEqual({ ok: false, reason: "a binary file is not previewed" });
    const hostile = `${"passwordtoken_".repeat(20_000)}=${"a".repeat(100_000)}`;
    const started = performance.now();
    secretInContent(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("checkTarget", () => {
  it("accepts a file inside the root", () => {
    expect(checkTarget(facts(join(root, "src", "a.ts")))).toEqual({ ok: true, real: join(root, "src", "a.ts") });
  });

  it("refuses a symlink that lands outside the roots", () => {
    expect(checkTarget(facts(join(root, "src", "escape.txt")))).toEqual({ ok: false, reason: "outside the project roots" });
  });

  it("accepts it once its landing directory is an extra root", () => {
    expect(checkTarget(facts(join(root, "src", "escape.txt"), [root, outside])).ok).toBe(true);
  });

  it("refuses a harmless name that resolves to a secret", () => {
    expect(checkTarget(facts(join(root, "src", "innocent.txt")))).toEqual({ ok: false, reason: "a secret-like file is never shown" });
  });

  it("refuses a secret name, a directory, a missing file, and a prefix-sharing sibling root", async () => {
    expect(checkTarget(facts(join(root, ".env.local"))).ok).toBe(false);
    expect(checkTarget(facts(join(root, "src"))).ok).toBe(false);
    expect(checkTarget(facts(join(root, "missing.ts"))).ok).toBe(false);
    await mkdir(`${root}-sibling`, { recursive: true });
    await writeFile(`${root}-sibling/b.ts`, "x");
    expect(checkTarget(facts(`${root}-sibling/b.ts`))).toEqual({ ok: false, reason: "outside the project roots" });
  });

  it("refuses everything when no root is left", () => {
    expect(checkTarget(facts(join(root, "src", "a.ts"), []))).toEqual({ ok: false, reason: "no project root to preview from (home and / are never one)" });
  });

  it("never takes home or / as a root", () => {
    expect(isForbiddenRoot("/", "/Users/me")).toBe(true);
    expect(isForbiddenRoot("/Users/me/", "/Users/me")).toBe(true);
    expect(isForbiddenRoot("/Users/me/project", "/Users/me")).toBe(false);
    expect(isForbiddenRoot("/Users/me", undefined)).toBe(false);
  });

  it("refuses NUL, newline and carriage return before touching anything", () => {
    for (const spelled of [`${root}/a\u0000.ts`, `${root}/a\n.ts`, `${root}/a\r.ts`]) {
      expect(checkTarget({ spelled, real: `${root}/a.ts`, kind: "file", roots: [root] })).toEqual({ ok: false, reason: "the path holds a control character" });
    }
  });

  it("folds a relative spelling against the cwd", () => {
    expect(absoluteOf("./src/../src/a.ts", root)).toBe(join(root, "src", "a.ts"));
    expect(absoluteOf("/etc/hosts", root)).toBe("/etc/hosts");
  });

  it("reads extra roots as absolute, colon separated", () => {
    expect(splitRoots("/a:relative: /b :")).toEqual(["/a", "/b"]);
    expect(splitRoots(undefined)).toEqual([]);
  });
});

describe.skipIf(!Bun.which("perl"))("read once (perl, O_NOFOLLOW, fstat)", () => {
  const readOnce = (path: string, cap?: number) => parseReadOnce(Bun.spawnSync(readOnceArgv(path, cap), { timeout: 5000 }).stdout.toString());

  it("answers the bytes of a regular file, up to the cap", async () => {
    const file = join(root, "src", "notes.txt");
    await writeFile(file, "hello world\n");
    const whole = readOnce(file);
    expect(whole.ok && new TextDecoder().decode(whole.bytes)).toBe("hello world\n");
    const head = readOnce(file, 5);
    expect(head).toMatchObject({ ok: true, size: 12, truncated: true });
    expect(head.ok && new TextDecoder().decode(head.bytes)).toBe("hello");
  });

  it("refuses a hard-linked file, whichever name is asked (F3)", async () => {
    await link(join(root, ".env.local"), join(root, "src", "hard.txt"));
    expect(checkTarget(facts(join(root, "src", "hard.txt"))).ok).toBe(true);
    expect(readOnce(join(root, "src", "hard.txt"))).toEqual({ ok: false, reason: "a file with more than one hard link is never shown" });
    await rm(join(root, "src", "hard.txt"));
  });

  it("does not follow a symlink swapped in after the gate passed (F4)", async () => {
    const file = join(root, "src", "swap.txt");
    await writeFile(file, "fine\n");
    const verdict = checkTarget(facts(file));
    expect(verdict.ok).toBe(true);
    await rm(file);
    await symlink(join(outside, "secret.txt"), file);
    expect(readOnce(verdict.ok ? verdict.real : "")).toEqual({ ok: false, reason: "the file could not be opened without following a link" });
  });

  it("notices a parent directory swapped for a symlink after the gate passed (F4)", async () => {
    await mkdir(join(root, "dirswap"), { recursive: true });
    await writeFile(join(root, "dirswap", "x.txt"), "fine\n");
    await mkdir(join(outside, "dirswap"), { recursive: true });
    await writeFile(join(outside, "dirswap", "x.txt"), "SECRET\n");
    const verdict = checkTarget(facts(join(root, "dirswap", "x.txt")));
    expect(verdict.ok).toBe(true);
    await rename(join(root, "dirswap"), join(root, "dirswap.old"));
    await symlink(join(outside, "dirswap"), join(root, "dirswap"));
    expect(readOnce(join(root, "dirswap", "x.txt"))).toEqual({ ok: false, reason: "the file moved while it was being read" });
  });

  it("refuses a FIFO swapped in, without hanging", async () => {
    const fifo = join(root, "src", "pipe.txt");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const started = performance.now();
    expect(readOnce(fifo)).toEqual({ ok: false, reason: "not a regular file" });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("parses nothing it does not recognise", () => {
    expect(parseReadOnce("garbage").ok).toBe(false);
    expect(parseReadOnce("OK 3 0\nnot base64!").ok).toBe(false);
  });
});

describe("binary and base64", () => {
  it("decodes base64, long inputs included, and flags a NUL byte", () => {
    expect(Array.from(decodeBase64(Buffer.from([1, 2, 0, 255]).toString("base64")))).toEqual([1, 2, 0, 255]);
    const big = Buffer.alloc(100_000, 7);
    expect(Buffer.from(decodeBase64(big.toString("base64"))).equals(big)).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text\n"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true);
  });
});

describe("path detection", () => {
  it("reads Read, Edit and Write rows only, with Read's offset as the line", () => {
    expect(toolTarget("Read", { file_path: "/p/a.ts", offset: 40 })).toEqual({ path: "/p/a.ts", line: 40 });
    expect(toolTarget("Edit", { file_path: "/p/a.ts", old_string: "x" })).toEqual({ path: "/p/a.ts", line: 0 });
    expect(toolTarget("Write", { file_path: "/p/b.md" })).toEqual({ path: "/p/b.md", line: 0 });
    expect(toolTarget("Bash", { command: "cat /p/a.ts" })).toBeUndefined();
    expect(toolTarget("Read", { file_path: "/p/a\n.ts" })).toBeUndefined();
    expect(toolTarget("Read", null)).toBeUndefined();
  });

  it("finds paths with a slash anywhere, bare names only in code spans, with a line suffix", () => {
    const text = "Changed `src/setup/units.ts` and ./docs/flow-map.md:12; see /abs/x.json. Also `README.md`, not README.txt, Node.js or https://x.dev/a.js.";
    expect(detectPaths(text)).toEqual([
      { path: "src/setup/units.ts", line: 0 },
      { path: "./docs/flow-map.md", line: 12 },
      { path: "/abs/x.json", line: 0 },
      { path: "README.md", line: 0 },
    ]);
  });

  it("skips version numbers and secret names, and keeps each path once, at most the limit", () => {
    expect(detectPaths("bump to `1.2.3` and v2.0.1")).toEqual([]);
    expect(detectPaths("see `.env.local` and config/.npmrc")).toEqual([]);
    expect(detectPaths("a/b.ts a/b.ts c/d.ts e/f.ts", 2).map((t) => t.path)).toEqual(["a/b.ts", "c/d.ts"]);
  });

  it("routes by extension", () => {
    expect(kindOf("a/b.PNG")).toBe("image");
    expect(kindOf("clip.mov")).toBe("video");
    expect(kindOf("x.heic")).toBe("image");
    expect(kindOf("Makefile")).toBe("text");
  });

  it("keeps at most the limit in the render cache, the oldest leaving first", () => {
    const cache = createBoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});

describe("editor command", () => {
  it("parses argv without a shell", () => {
    expect(parseCommand(`code --wait`)).toEqual(["code", "--wait"]);
    expect(parseCommand(`"/Applications/My Editor/bin/ed" -n 'a b' c\\ d ""`)).toEqual(["/Applications/My Editor/bin/ed", "-n", "a b", "c d", ""]);
    expect(parseCommand(`nvim; rm -rf /`)).toEqual(["nvim;", "rm", "-rf", "/"]);
    expect(parseCommand(`'open`)).toBeUndefined();
  });

  it("takes PB_EDITOR, then VISUAL, then EDITOR, then nvim", () => {
    expect(editorCommand({ PB_EDITOR: "hx", VISUAL: "vim", EDITOR: "nano" })).toEqual(["hx"]);
    expect(editorCommand({ PB_EDITOR: " ", VISUAL: "vim -u NONE", EDITOR: "nano" })).toEqual(["vim", "-u", "NONE"]);
    expect(editorCommand({ PB_EDITOR: "'broken", EDITOR: "nano" })).toEqual(["nano"]);
    expect(editorCommand({})).toEqual(["nvim"]);
  });

  it("puts the line where each editor family reads it", () => {
    expect(editorArgv(["nvim"], "/p/a.ts", 12)).toEqual(["nvim", "+12", "--", "/p/a.ts"]);
    expect(editorArgv(["code", "--reuse-window"], "/p/a.ts", 12)).toEqual(["code", "--reuse-window", "-g", "/p/a.ts:12"]);
    expect(editorArgv(["zed"], "/p/a.ts", 3)).toEqual(["zed", "/p/a.ts:3"]);
    expect(editorArgv(["nvim"], "/p/a.ts", 0)).toEqual(["nvim", "/p/a.ts"]);
  });
});

describe("command construction", () => {
  const nasty = `/p/it's "a" | $(rm -rf ~) b\\c.ts`;

  it("quotes every word of the one command string a Supacode tab's shell reads (checked against sh; fish not covered)", () => {
    const argv = supacodeTabArgv("x\ny", readOnlyNvimArgv(nasty, 7), true);
    expect(argv.slice(0, 7)).toEqual(["supacode", "tab", "new", "--background", "--title", "x y", "--input"]);
    const roundTrip = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${argv[7]}`]).stdout.toString();
    expect(roundTrip).toBe(`nvim\n-R\n+7\n--\n${nasty}\n`);
    expect(supacodeTabArgv("t", ["nvim"], false)).not.toContain("--background");
    expect(shQuote("")).toBe("''");
  });

  it("sends Neovim the checked bytes as base64 and the path only as a title", () => {
    expect(vimString(`it's`)).toBe(`'it''s'`);
    const expr = floatExpr(nasty, "aGk=\n", 5);
    expect(expr.startsWith("luaeval('")).toBe(true);
    expect(expr.endsWith(`, ['/p/it''s "a" | $(rm -rf ~) b\\c.ts', 'aGk=', 5])`)).toBe(true);
    expect(expr).not.toContain("readfile");
    expect(nvimExprArgv("/s", expr)).toEqual(["nvim", "--server", "/s", "--remote-expr", expr]);
    expect(openExpr("/p/a.ts", -3).endsWith(`['/p/a.ts', 0])`)).toBe(true);
  });

  it("builds thumbnails by argv, at most 800 px, in a mktemp directory", () => {
    expect(thumbnailArgv("video", "/p/v.mp4", "/c/k.png")).toEqual(["ffmpeg", "-v", "error", "-ss", "1", "-i", "/p/v.mp4", "-frames:v", "1", "-vf", "scale='min(800,iw)':-2", "-y", "/c/k.png"]);
    expect(thumbnailArgv("image", "/p/i.jpg", "/c/k.png")).toEqual(["sips", "-s", "format", "png", "-Z", "800", "/p/i.jpg", "--out", "/c/k.png"]);
    expect(privateDirArgv("/var/T/")).toEqual(["mktemp", "-d", "/var/T/pb-file-preview.XXXXXX"]);
    expect(privateDirArgv(undefined)).toEqual(["mktemp", "-d", "/tmp/pb-file-preview.XXXXXX"]);
  });

  it("draws plain lines in the pane", () => {
    expect(headLines("a\tb\n\u001b[31mred\u001b[0m\r\nlast", 2, 4)).toEqual(["a  b", "[31m"]);
  });
});

describe("Neovim server search", () => {
  const cwds: Record<string, string> = { "/s/explicit": "/elsewhere", "/s/one": "/other", "/s/two": "/proj\n" };
  const cwdOf = async (server: string) => cwds[server];

  it("takes PB_NVIM_SERVER, then $NVIM, when they answer", async () => {
    expect(await pickServer({ explicit: "/s/explicit", inherited: "/s/one", sockets: [], projectDirs: ["/proj"], cwdOf })).toBe("/s/explicit");
    expect(await pickServer({ explicit: "/s/dead", inherited: "/s/one", sockets: [], projectDirs: ["/proj"], cwdOf })).toBe("/s/one");
  });

  it("otherwise picks the socket whose cwd is the project, never another project's", async () => {
    expect(await pickServer({ sockets: ["/s/one", "/s/two"], projectDirs: ["/proj/"], cwdOf })).toBe("/s/two");
    expect(await pickServer({ sockets: ["/s/one"], projectDirs: ["/proj"], cwdOf })).toBeUndefined();
  });

  it("asks every socket at once, so hung ones cost one timeout in all (F5)", async () => {
    const slow = async (server: string) => {
      await Bun.sleep(100);
      return server === "/s/c" ? "/proj" : undefined;
    };
    const started = performance.now();
    expect(await pickServer({ sockets: ["/s/a", "/s/b", "/s/c", "/s/d"], projectDirs: ["/proj"], cwdOf: slow })).toBe("/s/c");
    expect(performance.now() - started).toBeLessThan(300);
  });

  it("skips a failed server for 30 seconds", () => {
    const memo = createFailureMemo(30_000);
    memo.fail("/s/dead", 1_000);
    expect(memo.isSkipped("/s/dead", 30_999)).toBe(true);
    expect(memo.isSkipped("/s/dead", 31_000)).toBe(false);
    memo.fail("/s/dead", 40_000);
    memo.ok("/s/dead");
    expect(memo.isSkipped("/s/dead", 40_001)).toBe(false);
  });

  it("looks where Neovim puts default sockets, with or without TMPDIR", () => {
    expect(isDefaultSocketName("nvim.8574.0")).toBe(true);
    expect(isDefaultSocketName("nvim.sock")).toBe(false);
    expect(socketDirs({ TMPDIR: "/var/T/", USER: "me" })).toEqual([
      { dir: "/var/T/nvim.me", nested: true },
      { dir: "/tmp/nvim.me", nested: true },
    ]);
    expect(socketDirs({ USER: "me", XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual([
      { dir: "/tmp/nvim.me", nested: true },
      { dir: "/run/user/1000", nested: false },
    ]);
    expect(socketDirs({ USER: "../x" })).toEqual([]);
  });
});

describe("createLatest", () => {
  it("debounces: only the last of a burst runs", async () => {
    const ran: number[] = [];
    const latest = createLatest((ms) => new Promise((resolve) => setTimeout(resolve, ms)), 20);
    const results = await Promise.all([1, 2, 3].map((n) => latest.run(async () => (ran.push(n), n))));
    expect(ran).toEqual([3]);
    expect(results).toEqual([undefined, undefined, 3]);
  });

  it("drops a slow result once a newer request has started", async () => {
    const latest = createLatest(async () => undefined, 0);
    let release!: () => void;
    const slow = latest.run(async (isCurrent) => {
      await new Promise<void>((resolve) => (release = resolve));
      return isCurrent() ? "slow" : "stale";
    });
    await Bun.sleep(1);
    const fast = await latest.run(async () => "fast");
    release();
    expect(fast).toBe("fast");
    expect(await slow).toBeUndefined();
  });
});

describe.skipIf(!Bun.which("nvim"))("Neovim float, against a headless Neovim of the test's own", () => {
  let sock: string;
  let server: ReturnType<typeof Bun.spawn>;
  let file: string;
  const body = Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n");
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  const expr = (text: string) => {
    const done = Bun.spawnSync(nvimExprArgv(sock, text), { timeout: 5000 });
    expect(done.exitCode).toBe(0);
    return done.stdout.toString().trim();
  };
  const state = () =>
    JSON.parse(
      expr(
        `luaeval('vim.json.encode({ wins = #vim.api.nvim_list_wins(), cur = vim.api.nvim_get_current_win(), buf = vim.api.nvim_buf_get_name(0), float = vim.g.pb_file_preview_win and vim.api.nvim_win_is_valid(vim.g.pb_file_preview_win) and vim.api.nvim_win_get_config(vim.g.pb_file_preview_win) or vim.NIL, tabs = #vim.api.nvim_list_tabpages() })')`
      )
    );
  const floatLine = (win: number, n: number) => expr(`luaeval('vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(${win}), ${n - 1}, ${n}, false)[1]')`);

  beforeAll(async () => {
    sock = join(dir, "nvim.sock");
    file = join(root, `it's "odd" | name.ts`);
    await writeFile(file, body);
    server = Bun.spawn(["nvim", "--headless", "-u", "NONE", "-i", "NONE", "-n", "--listen", sock], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && Bun.spawnSync(nvimExprArgv(sock, "1")).exitCode !== 0; i++) await Bun.sleep(20);
  });
  afterAll(() => server?.kill());

  it("opens a non-focusable editor-relative float without moving the cursor window, and closes it on the next cursor move", () => {
    const before = state();
    const win = Number(expr(floatExpr(file, b64(body), 30)));
    const during = state();
    expect(during.wins).toBe(before.wins + 1);
    expect(during.cur).toBe(before.cur);
    expect(during.buf).toBe(before.buf);
    expect(during.float.relative).toBe("editor");
    expect(during.float.focusable).toBe(false);
    expect(floatLine(win, 30)).toBe("const line30 = 30");
    expect(expr(`luaeval('vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(${win}))')`)).toBe("");

    const second = Number(expr(floatExpr(file, b64(body), 0)));
    expect(second).not.toBe(win);
    expect(state().wins).toBe(before.wins + 1);

    expr(`luaeval('vim.api.nvim_exec_autocmds("CursorMoved", {})')`);
    const after = state();
    expect(after.wins).toBe(before.wins);
    expect(after.float).toBeNull();
  });

  it("shows only the bytes it was handed and never opens the path: a FIFO path cannot hang it (F4)", async () => {
    const fifo = join(root, "src", "float-pipe.ts");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const win = Number(expr(floatExpr(fifo, b64("checked bytes\r\nsecond\n"), 0)));
    expect(floatLine(win, 1)).toBe("checked bytes");
    expect(floatLine(win, 2)).toBe("second");
    expr(`luaeval('vim.api.nvim_exec_autocmds("CursorMoved", {})')`);
  });

  it("opens the file for editing at the line through `tab drop`, a second open reusing its tab", () => {
    expect(expr(openExpr(file, 12))).toBe("1");
    expect(state().buf).toBe(file);
    expect(expr(`line('.')`)).toBe("12");
    const tabs = state().tabs;
    expr(`luaeval('vim.cmd.tabnew() or 1')`);
    expect(expr(openExpr(file, 20))).toBe("1");
    expect(state().tabs).toBe(tabs + 1);
    expect(state().buf).toBe(file);
    expect(expr(`line('.')`)).toBe("20");
  });

  it("refuses to open anything but a regular file, so a FIFO cannot hang the editor", () => {
    expect(expr(openExpr(join(root, "src", "float-pipe.ts"), 0))).toBe("0");
  });
});
