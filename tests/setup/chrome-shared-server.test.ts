import { describe, it, expect } from "bun:test";

const MOD = "../../src/setup/chrome-shared-server.js";

const spec = {
  port: 39100,
  bridgeBin: "/home/u/.local/bin/mcp-proxy",
  command: ["/usr/bin/npx", "-y", "chrome-devtools-mcp@latest", "--autoConnect"],
  logPath: "/home/u/.project-brain/chrome-devtools-shared.log",
  path: "/home/u/.local/bin:/usr/bin:/bin",
};

describe("where a shared server can be held open", () => {
  it("names a service manager only on platforms that have one", async () => {
    const { serviceKindFor } = await import(MOD);

    expect(serviceKindFor("darwin")).toBe("launchd");
    expect(serviceKindFor("linux")).toBe("systemd");
    expect(serviceKindFor("win32")).toBeNull();
  });
});

describe("the bridge invocation", () => {
  it("listens on loopback and proxies to the command verbatim", async () => {
    const { bridgeArgv, BRIDGE_HOST } = await import(MOD);

    expect(bridgeArgv(spec)).toEqual([
      "/home/u/.local/bin/mcp-proxy",
      "--port",
      "39100",
      "--host",
      BRIDGE_HOST,
      "--",
      "/usr/bin/npx",
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
    ]);

    // Loopback is the point: a CDP bridge on 0.0.0.0 is remote control of the
    // user's browser, offered to the network.
    expect(BRIDGE_HOST).toBe("127.0.0.1");
  });

  it("pins the MCP SDK when installing, because the default resolution breaks", async () => {
    const { bridgeInstallArgs, BRIDGE_SDK_CONSTRAINT } = await import(MOD);

    // Without this the tool installs cleanly and then dies at import with
    // `ImportError: cannot import name 'request_ctx'`. The constraint is the
    // difference between a working install and a silently broken one.
    expect(BRIDGE_SDK_CONSTRAINT).toBe("mcp<2");
    expect(bridgeInstallArgs()).toContain("--with");
    expect(bridgeInstallArgs()).toContain("mcp<2");
  });
});

describe("the host entry that replaces a per-session server", () => {
  it("points at the bridge over http", async () => {
    const { sharedEntry, sharedUrl } = await import(MOD);

    expect(sharedEntry(39100)).toEqual({ type: "http", url: "http://127.0.0.1:39100/mcp" });
    expect(sharedUrl(41000)).toBe("http://127.0.0.1:41000/mcp");
  });

  it("recognises its own entry by URL, and not one on another port", async () => {
    const { isSharedEntry, sharedEntry } = await import(MOD);

    expect(isSharedEntry(sharedEntry(39100), 39100)).toBe(true);
    expect(isSharedEntry(sharedEntry(41000), 39100)).toBe(false);
    expect(isSharedEntry({ command: "npx", args: ["chrome-devtools-mcp"] }, 39100)).toBe(false);
    expect(isSharedEntry(null, 39100)).toBe(false);
  });
});

describe("the service definition", () => {
  it("keeps the server alive across sessions and logs where it was told to", async () => {
    const { launchdPlist, SERVICE_LABEL } = await import(MOD);
    const plist = launchdPlist(spec);

    // KeepAlive is not a nicety: the arrangement only works if the one server
    // outlives every session that connects to it.
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain(SERVICE_LABEL);
    expect(plist).toContain(spec.logPath);
    expect(plist).toContain("<string>--autoConnect</string>");
  });

  it("escapes every XML metacharacter, not only the obvious ones", async () => {
    const { launchdPlist } = await import(MOD);
    const plist = launchdPlist({
      ...spec,
      command: ["/usr/bin/node", `--title=a&b<c>d"e'f`],
    });

    expect(plist).toContain("--title=a&amp;b&lt;c&gt;d&quot;e&apos;f");
    expect(plist).not.toContain(`d"e'f`);
  });

  it("quotes systemd arguments that contain spaces, which it would otherwise split", async () => {
    const { systemdUnit } = await import(MOD);
    const unit = systemdUnit({
      ...spec,
      command: ["/opt/my tools/node", "server.js"],
    });

    expect(unit).toContain(`"/opt/my tools/node"`);
    expect(unit).toContain("Restart=always");
  });
});

describe("guarding against a path that dies with the shell", () => {
  it("refuses a node version manager's per-shell directory and names the stable one", async () => {
    const { ephemeralPathWarning } = await import(MOD);

    const warning = ephemeralPathWarning(
      "/home/u/.local/state/fnm_multishells/47631_1790003468021/bin/npx"
    );
    expect(warning).toContain("fnm_multishells");
    expect(warning).toContain("aliases/default");

    expect(ephemeralPathWarning("/home/u/.nvm/versions/node/v22.0.0/bin/npx")).not.toBeNull();
  });

  it("passes a stable path through without complaint", async () => {
    const { ephemeralPathWarning } = await import(MOD);

    expect(ephemeralPathWarning("/usr/bin/npx")).toBeNull();
    expect(ephemeralPathWarning("/home/u/.local/share/fnm/aliases/default/bin/npx")).toBeNull();
  });
});

describe("recovering from a server that has grown", () => {
  it("names the restart for the platform's own service manager", async () => {
    const { restartCommand, SERVICE_LABEL } = await import(MOD);

    expect(restartCommand("launchd")).toContain("launchctl kickstart");
    expect(restartCommand("launchd")).toContain(SERVICE_LABEL);
    expect(restartCommand("systemd")).toContain("systemctl --user restart");
  });
});

describe("reading back a service someone already installed", () => {
  it("recovers the argv of a plist and a systemd unit, spaces included", async () => {
    const { launchdPlist, systemdUnit, serviceArgv, bridgeArgv } = await import(MOD);
    const spaced = { ...spec, command: ["/opt/my node/bin/node", "chrome-devtools-mcp", "--autoConnect"] };

    expect(serviceArgv("launchd", launchdPlist(spaced))).toEqual(bridgeArgv(spaced));
    expect(serviceArgv("systemd", systemdUnit(spaced))).toEqual(bridgeArgv(spaced));
  });

  it("answers null for a service with no command it can read", async () => {
    const { serviceArgv } = await import(MOD);
    expect(serviceArgv("launchd", "<plist><dict></dict></plist>")).toBeNull();
    expect(serviceArgv("systemd", "[Service]\nRestart=always\n")).toBeNull();
  });

  it("knows the server behind the bridge from the argv", async () => {
    const { servedChromeArgs } = await import(MOD);
    const argv = ["/bin/mcp-proxy", "--port", "39100", "--", "node", "/x/chrome-devtools-mcp-main.js", "--autoConnect"];

    expect(servedChromeArgs(argv)).toEqual(["/x/chrome-devtools-mcp-main.js", "--autoConnect"]);
    expect(servedChromeArgs(["/bin/some-other-daemon", "--flag"])).toBeNull();
  });
});
