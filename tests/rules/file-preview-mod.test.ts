import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_NAMES,
  absoluteOf,
  checkTarget,
  createLatest,
  decodeBase64,
  detectPaths,
  editorArgv,
  editorCommand,
  floatExpr,
  hasPrivateKey,
  headLines,
  isDefaultSocketName,
  isSecretName,
  kindOf,
  looksBinary,
  nvimExprArgv,
  openExpr,
  parseCommand,
  pickServer,
  readOnlyNvimArgv,
  shQuote,
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

describe("secret names", () => {
  it("are one list holding every pattern the owner named", () => {
    for (const glob of [".env*", "*.pem", "*.key", "id_rsa*", "credentials*", "*.p12", ".npmrc", ".netrc"]) expect(SECRET_NAMES).toContain(glob);
  });

  it.each([
    ".env",
    ".env.local",
    "/x/.ENV.production",
    "server.pem",
    "tls.KEY",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "credentials.json",
    "cert.p12",
    ".npmrc",
    ".netrc",
    "/home/u/.ssh/config",
    "/home/u/.aws/config",
  ])("refuses %s", (path) => {
    expect(isSecretName(path)).toBe(true);
  });

  it.each(["src/env.ts", "keyboard.ts", "docs/credentials-guide.md/x.ts", "README.md", "environment.md"])("lets %s through", (path) => {
    expect(isSecretName(path)).toBe(false);
  });

  it("finds a private key by content", () => {
    expect(hasPrivateKey("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBe(true);
    expect(hasPrivateKey("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(hasPrivateKey("-----BEGIN CERTIFICATE-----")).toBe(false);
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

describe("binary sniffing", () => {
  it("decodes base64 and flags a NUL byte", () => {
    expect(Array.from(decodeBase64(Buffer.from([1, 2, 0, 255]).toString("base64")))).toEqual([1, 2, 0, 255]);
    expect(looksBinary(decodeBase64(Buffer.from("plain text\n").toString("base64")))).toBe(false);
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

  it("finds paths in prose, code spans and lists, with a line suffix", () => {
    const text = "Changed `src/setup/units.ts` and ./docs/flow-map.md:12; see /abs/x.json. Also README.md, not https://x.dev/a.js.";
    expect(detectPaths(text)).toEqual([
      { path: "src/setup/units.ts", line: 0 },
      { path: "./docs/flow-map.md", line: 12 },
      { path: "/abs/x.json", line: 0 },
      { path: "README.md", line: 0 },
    ]);
  });

  it("skips version numbers and keeps each path once, at most the limit", () => {
    expect(detectPaths("bump to 1.2.3 and v2.0.1")).toEqual([]);
    expect(detectPaths("a/b.ts a/b.ts c/d.ts e/f.ts", 2).map((t) => t.path)).toEqual(["a/b.ts", "c/d.ts"]);
  });

  it("routes by extension", () => {
    expect(kindOf("a/b.PNG")).toBe("image");
    expect(kindOf("clip.mov")).toBe("video");
    expect(kindOf("x.heic")).toBe("image");
    expect(kindOf("Makefile")).toBe("text");
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
  const nasty = `/p/it's "a" | $(rm -rf ~) b.ts`;

  it("quotes every word of the one command string a Supacode tab's shell reads", () => {
    const argv = supacodeTabArgv("x\ny", readOnlyNvimArgv(nasty, 7), true);
    expect(argv.slice(0, 7)).toEqual(["supacode", "tab", "new", "--background", "--title", "x y", "--input"]);
    expect(argv[7]).toBe(`'nvim' '-R' '+7' '--' '/p/it'\\''s "a" | $(rm -rf ~) b.ts'`);
    const roundTrip = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${argv[7]}`]).stdout.toString();
    expect(roundTrip).toBe(`nvim\n-R\n+7\n--\n${nasty}\n`);
    expect(supacodeTabArgv("t", ["nvim"], false)).not.toContain("--background");
    expect(shQuote("")).toBe("''");
  });

  it("passes the path to Neovim as data inside a Vim single-quoted literal", () => {
    expect(vimString(`it's`)).toBe(`'it''s'`);
    const expr = floatExpr(nasty, 5);
    expect(expr.startsWith("luaeval('")).toBe(true);
    expect(expr.endsWith(`, ['/p/it''s "a" | $(rm -rf ~) b.ts', 5, 2000])`)).toBe(true);
    expect(nvimExprArgv("/s", expr)).toEqual(["nvim", "--server", "/s", "--remote-expr", expr]);
    expect(openExpr("/p/a.ts", -3).endsWith(`['/p/a.ts', 0])`)).toBe(true);
  });

  it("builds thumbnails by argv, at most 800 px", () => {
    expect(thumbnailArgv("video", "/p/v.mp4", "/c/k.png")).toEqual(["ffmpeg", "-v", "error", "-ss", "1", "-i", "/p/v.mp4", "-frames:v", "1", "-vf", "scale='min(800,iw)':-2", "-y", "/c/k.png"]);
    expect(thumbnailArgv("image", "/p/i.jpg", "/c/k.png")).toEqual(["sips", "-s", "format", "png", "-Z", "800", "/p/i.jpg", "--out", "/c/k.png"]);
  });

  it("draws plain lines in the pane", () => {
    expect(headLines("a\tb\n\u001b[31mred\u001b[0m\r\nlast", 2, 4)).toEqual(["a  b", "[31m"]);
  });
});

describe("pickServer", () => {
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

  it("knows Neovim's default socket names", () => {
    expect(isDefaultSocketName("nvim.8574.0")).toBe(true);
    expect(isDefaultSocketName("nvim.sock")).toBe(false);
    expect(isDefaultSocketName("nvim.12.0.bak")).toBe(false);
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

  beforeAll(async () => {
    sock = join(dir, "nvim.sock");
    file = join(root, `it's "odd" | name.ts`);
    await writeFile(file, Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n"));
    server = Bun.spawn(["nvim", "--headless", "-u", "NONE", "-i", "NONE", "-n", "--listen", sock], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && Bun.spawnSync(nvimExprArgv(sock, "1")).exitCode !== 0; i++) await Bun.sleep(20);
  });
  afterAll(() => server?.kill());

  it("opens a non-focusable editor-relative float without moving the cursor window, and closes it on the next cursor move", () => {
    const before = state();
    const win = Number(expr(floatExpr(file, 30)));
    const during = state();
    expect(during.wins).toBe(before.wins + 1);
    expect(during.cur).toBe(before.cur);
    expect(during.buf).toBe(before.buf);
    expect(during.float.relative).toBe("editor");
    expect(during.float.focusable).toBe(false);
    expect(expr(`luaeval('vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(${win}), 29, 30, false)[1]')`)).toBe("const line30 = 30");
    expect(expr(`luaeval('vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(${win}))')`)).toBe("");

    const second = Number(expr(floatExpr(file, 0)));
    expect(second).not.toBe(win);
    expect(state().wins).toBe(before.wins + 1);

    expr(`luaeval('vim.api.nvim_exec_autocmds("CursorMoved", {})')`);
    const after = state();
    expect(after.wins).toBe(before.wins);
    expect(after.float).toBeNull();
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
});
