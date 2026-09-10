import { describe, it, expect } from "bun:test";

describe("chrome-devtools MCP entry detection", () => {
  it("recognises the server by its package name, whatever the entry is keyed as", async () => {
    const { isChromeDevtoolsEntry } = await import("../../src/setup/chrome-autoconnect.js");

    expect(
      isChromeDevtoolsEntry({ command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] })
    ).toBe(true);
    expect(isChromeDevtoolsEntry({ command: "/opt/bin/chrome-devtools-mcp", args: [] })).toBe(true);
    expect(isChromeDevtoolsEntry({ command: "npx", args: ["-y", "@playwright/mcp"] })).toBe(false);
    expect(isChromeDevtoolsEntry({ url: "https://example.com/mcp" })).toBe(false);
    expect(isChromeDevtoolsEntry(null)).toBe(false);
  });

  it("finds every chrome-devtools entry under the host's container key", async () => {
    const { findChromeDevtoolsEntries } = await import("../../src/setup/chrome-autoconnect.js");

    const config = {
      mcpServers: {
        "project-brain": { command: "project-brain", args: [] },
        chrome: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
        "chrome-canary": { command: "npx", args: ["chrome-devtools-mcp", "--channel=canary"] },
      },
    };

    expect(findChromeDevtoolsEntries(config, "mcpServers").map(([name]) => name)).toEqual([
      "chrome",
      "chrome-canary",
    ]);
    expect(findChromeDevtoolsEntries({}, "mcpServers")).toEqual([]);
    expect(findChromeDevtoolsEntries({ servers: "nope" }, "servers")).toEqual([]);
  });
});

describe("autoConnect state of one entry", () => {
  it("reads the flag in either spelling, and in its `=value` form", async () => {
    const { entryAutoConnectState } = await import("../../src/setup/chrome-autoconnect.js");
    const state = (args: string[]) => entryAutoConnectState({ command: "npx", args });

    expect(state(["chrome-devtools-mcp", "--autoConnect"])).toBe("present");
    expect(state(["chrome-devtools-mcp", "--auto-connect"])).toBe("present");
    expect(state(["chrome-devtools-mcp", "--autoConnect=true"])).toBe("present");
    expect(state(["chrome-devtools-mcp"])).toBe("missing");
    expect(state(["chrome-devtools-mcp", "--headless"])).toBe("missing");
  });

  it("treats an explicit opt-out as the user's answer, not as something to fix", async () => {
    const { entryAutoConnectState } = await import("../../src/setup/chrome-autoconnect.js");
    const state = (args: string[]) => entryAutoConnectState({ command: "npx", args });

    expect(state(["chrome-devtools-mcp", "--no-auto-connect"])).toBe("unsupported");
    expect(state(["chrome-devtools-mcp", "--noAutoConnect"])).toBe("unsupported");
    expect(state(["chrome-devtools-mcp", "--autoConnect=false"])).toBe("unsupported");
  });

  it("leaves an entry alone when a flag chrome-devtools cannot combine with autoConnect is set", async () => {
    const { entryAutoConnectState } = await import("../../src/setup/chrome-autoconnect.js");
    const state = (args: string[]) => entryAutoConnectState({ command: "npx", args });

    // Its own --help: "autoConnect, browserUrl, and wsEndpoint are not supported".
    expect(state(["chrome-devtools-mcp", "--browserUrl", "http://127.0.0.1:9222"])).toBe(
      "unsupported"
    );
    expect(state(["chrome-devtools-mcp", "-u", "http://127.0.0.1:9222"])).toBe("unsupported");
    expect(state(["chrome-devtools-mcp", "--wsEndpoint", "ws://127.0.0.1:9222/x"])).toBe(
      "unsupported"
    );
    expect(state(["chrome-devtools-mcp", "--categoryExtensions"])).toBe("unsupported");
    expect(state(["chrome-devtools-mcp", "--categoryPwa"])).toBe("unsupported");
  });
});

describe("editing one entry's args", () => {
  it("appends the flag, creating the args array when the entry has none", async () => {
    const { addAutoConnect } = await import("../../src/setup/chrome-autoconnect.js");

    const withArgs: any = { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] };
    addAutoConnect(withArgs);
    expect(withArgs.args).toEqual(["-y", "chrome-devtools-mcp@latest", "--autoConnect"]);

    const bare: any = { command: "chrome-devtools-mcp" };
    addAutoConnect(bare);
    expect(bare.args).toEqual(["--autoConnect"]);
  });

  it("never appends the flag twice", async () => {
    const { addAutoConnect } = await import("../../src/setup/chrome-autoconnect.js");

    const entry: any = { command: "npx", args: ["chrome-devtools-mcp", "--auto-connect"] };
    addAutoConnect(entry);
    expect(entry.args).toEqual(["chrome-devtools-mcp", "--auto-connect"]);
  });

  it("removes only the flag, in every spelling, and leaves the rest of the entry intact", async () => {
    const { removeAutoConnect } = await import("../../src/setup/chrome-autoconnect.js");

    const entry: any = {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--autoConnect", "--headless"],
      env: {},
    };
    removeAutoConnect(entry);
    expect(entry.args).toEqual(["-y", "chrome-devtools-mcp@latest", "--headless"]);
    expect(entry.command).toBe("npx");
    expect(entry.env).toEqual({});

    const alt: any = { command: "npx", args: ["chrome-devtools-mcp", "--auto-connect=true"] };
    removeAutoConnect(alt);
    expect(alt.args).toEqual(["chrome-devtools-mcp"]);
  });

  it("leaves an explicit opt-out in place — removing it would flip the user's answer", async () => {
    const { removeAutoConnect } = await import("../../src/setup/chrome-autoconnect.js");

    const entry: any = { command: "npx", args: ["chrome-devtools-mcp", "--no-auto-connect"] };
    removeAutoConnect(entry);
    expect(entry.args).toEqual(["chrome-devtools-mcp", "--no-auto-connect"]);
  });
});

describe("the warning shown before this mode is used", () => {
  it("quotes Chrome's own words rather than paraphrasing them", async () => {
    const { REMOTE_DEBUGGING_WARNING, TOGGLE_URL } = await import(
      "../../src/setup/chrome-autoconnect.js"
    );

    expect(TOGGLE_URL).toBe("chrome://inspect/#remote-debugging");
    expect(REMOTE_DEBUGGING_WARNING).toContain("full control of this browser");
    expect(REMOTE_DEBUGGING_WARNING).toContain("saved data, cookies and site data");
    expect(REMOTE_DEBUGGING_WARNING).toContain("navigate to any URL");
  });
});
