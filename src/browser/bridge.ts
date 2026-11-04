/**
 * One tool call through the shared bridge, the same HTTP endpoint every session uses.
 * Null on any failure: an unreachable bridge is a status, not an error.
 */

export async function callBridgeTool(
  url: string,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 4000
): Promise<string | null> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "project-brain-browser", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async () => {
      await client.connect(transport);
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (res.content ?? []).map((c) => c.text ?? "").join("\n");
    })();
    run.catch(() => {});
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([run.catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
