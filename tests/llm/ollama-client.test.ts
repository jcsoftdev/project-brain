import { describe, expect, it } from "bun:test";
import { LlmUnavailableError, stripThinking } from "../../src/llm/client.js";
import { conceptNumCtx, createOllamaClient } from "../../src/llm/ollama-client.js";

type Call = { url: string; body: any; signal: AbortSignal | undefined };

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)), signal: init.signal ?? undefined };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const ok = (content: string) => Response.json({ message: { role: "assistant", content } });

describe("createOllamaClient", () => {
  it("posts a non-streaming chat to the bulk host with thinking off and a sized context", async () => {
    const { calls, fetchFn } = fakeFetch(() => ok("## Purpose\n\nx"));
    const llm = createOllamaClient({ model: "qwen3.5:4b", host: "http://127.0.0.1:11434/", fetch: fetchFn });
    expect(await llm.complete("hello")).toBe("## Purpose\n\nx");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].body).toMatchObject({
      model: "qwen3.5:4b",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      think: false,
      options: { num_ctx: 8192, num_predict: 2048 },
    });
    expect(calls[0].signal).toBeDefined();
  });

  it("strips <think> blocks, closed or left open", async () => {
    const { fetchFn } = fakeFetch(() => ok("<think>plan the doc</think>\n## Purpose\n\nx"));
    expect(await createOllamaClient({ model: "m", fetch: fetchFn }).complete("p")).toBe("## Purpose\n\nx");
    expect(stripThinking("## Purpose\n\nx<think>never closed")).toBe("## Purpose\n\nx");
  });

  it("retries without the think field when the model rejects it", async () => {
    const { calls, fetchFn } = fakeFetch((_, i) =>
      i === 0 ? new Response(JSON.stringify({ error: '"llava" does not support thinking' }), { status: 400 }) : ok("doc")
    );
    expect(await createOllamaClient({ model: "llava", fetch: fetchFn }).complete("p")).toBe("doc");
    expect(calls[1].body.think).toBeUndefined();
  });

  it("reports a model that is not pulled as unavailable, naming the pull command", async () => {
    const { fetchFn } = fakeFetch(() => new Response(JSON.stringify({ error: "model 'qwen3.5:4b' not found" }), { status: 404 }));
    const run = createOllamaClient({ model: "qwen3.5:4b", fetch: fetchFn }).complete("p");
    await expect(run).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(run).rejects.toThrow("ollama pull qwen3.5:4b");
  });

  it("reports an unreachable Ollama as unavailable", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    await expect(createOllamaClient({ model: "m", fetch: fetchFn }).complete("p")).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("times out as a plain error, so the module is retried rather than the run abandoned", async () => {
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const run = createOllamaClient({ model: "m", fetch: fetchFn, timeoutMs: 20 }).complete("p");
    await expect(run).rejects.toThrow("timed out");
    await expect(run).rejects.not.toBeInstanceOf(LlmUnavailableError);
  });

  it("grows the context with the prompt, capped", () => {
    expect(conceptNumCtx("x".repeat(100))).toBe(8192);
    expect(conceptNumCtx("x".repeat(30_000))).toBe(16384);
    expect(conceptNumCtx("x".repeat(1_000_000))).toBe(32768);
  });
});
