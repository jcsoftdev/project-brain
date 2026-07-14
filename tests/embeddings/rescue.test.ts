import { describe, it, expect } from "bun:test";
import type { EmbeddingClient } from "../../src/types.js";
import { rescueEmbedPass } from "../../src/embeddings/rescue.js";

/** Builds a minimal fake EmbeddingClient around a supplied embed() impl. */
function makeClient(
  embed: (texts: string[]) => Promise<number[][] | null>,
  reset?: () => void
): EmbeddingClient {
  return {
    dim: 4,
    embed,
    isAvailable: async () => true,
    reset,
  };
}

describe("rescueEmbedPass", () => {
  it("embeds every remaining chunk one-by-one when the client only accepts single texts", async () => {
    const calls: number[] = [];
    const client = makeClient(async (texts) => {
      calls.push(texts.length);
      if (texts.length > 1) return null; // batches still fail
      return texts.map(() => [0.1, 0.1, 0.1, 0.1]);
    });

    const texts = ["a", "b", "c"];
    const indices = [0, 1, 2];
    const embeddedVectors: (number[] | null)[] = [null, null, null];

    await rescueEmbedPass(client, texts, indices, embeddedVectors);

    expect(embeddedVectors).toEqual([
      [0.1, 0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1, 0.1],
    ]);
    // every request made by the rescue pass must be single-text (batch size 1)
    expect(calls.every((n) => n === 1)).toBe(true);
  });

  it("recovers a flaky text that fails twice then succeeds, sleeping with growing backoff between attempts", async () => {
    let attempts = 0;
    const client = makeClient(async (texts) => {
      attempts++;
      if (attempts < 3) return null; // fail twice
      return texts.map(() => [1, 1, 1, 1]);
    });

    const sleeps: number[] = [];
    const fakeSleep = async (ms: number) => {
      sleeps.push(ms);
    };

    const texts = ["flaky"];
    const indices = [0];
    const embeddedVectors: (number[] | null)[] = [null];

    await rescueEmbedPass(client, texts, indices, embeddedVectors, { sleeps: fakeSleep });

    expect(embeddedVectors[0]).toEqual([1, 1, 1, 1]);
    expect(attempts).toBe(3);
    // Backoff between consecutive failures grows: 1s then 2s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("leaves a chunk null when every attempt fails, without throwing", async () => {
    const client = makeClient(async () => null);
    const sleeps: number[] = [];

    const texts = ["dead"];
    const indices = [0];
    const embeddedVectors: (number[] | null)[] = [null];

    await rescueEmbedPass(client, texts, indices, embeddedVectors, {
      sleeps: async (ms) => { sleeps.push(ms); },
    });

    expect(embeddedVectors[0]).toBeNull();
    // 3 attempts total means 2 backoff sleeps for a single always-failing text.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("caps backoff at 4s across consecutive failures spanning multiple texts", async () => {
    const client = makeClient(async () => null);
    const sleeps: number[] = [];

    const texts = ["one", "two"];
    const indices = [0, 1];
    const embeddedVectors: (number[] | null)[] = [null, null];

    await rescueEmbedPass(client, texts, indices, embeddedVectors, {
      sleeps: async (ms) => { sleeps.push(ms); },
    });

    // text "one": 3 attempts, always failing -> sleeps before attempt 2 and 3: 1000, 2000
    // (backoff now capped at 4000 after the 2nd sleep).
    // text "two": every attempt still inherits the carried-over "just failed"
    // state from text "one"'s last attempt, so its first attempt also sleeps
    // (backoff already capped) -> 4000, 4000, 4000 (3 attempts, no success ever).
    expect(sleeps).toEqual([1000, 2000, 4000, 4000, 4000]);
  });

  it("resets backoff to 1s after any success", async () => {
    let call = 0;
    const client = makeClient(async (texts) => {
      call++;
      // "one": fails once then succeeds (1 sleep of 1000ms)
      // "two": fails once then succeeds again -> backoff must restart at 1000ms, not continue growing
      if (call === 1 || call === 3) return null;
      return texts.map(() => [2, 2, 2, 2]);
    });
    const sleeps: number[] = [];

    const texts = ["one", "two"];
    const indices = [0, 1];
    const embeddedVectors: (number[] | null)[] = [null, null];

    await rescueEmbedPass(client, texts, indices, embeddedVectors, {
      sleeps: async (ms) => { sleeps.push(ms); },
    });

    expect(embeddedVectors[0]).toEqual([2, 2, 2, 2]);
    expect(embeddedVectors[1]).toEqual([2, 2, 2, 2]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("calls reset() once before the rescue pass begins, and again before every retry-after-backoff", async () => {
    let resetCalls = 0;
    let embedCalls = 0;
    const client = makeClient(
      async () => {
        embedCalls++;
        if (embedCalls < 2) return null;
        return [[3, 3, 3, 3]];
      },
      () => { resetCalls++; }
    );

    await rescueEmbedPass(client, ["x"], [0], [null], {
      sleeps: async () => {},
    });

    // 1 reset before the pass starts + 1 reset before the single retry-after-backoff.
    expect(resetCalls).toBe(2);
  });

  it("is a no-op (does not call embed) when there are no failed indices", async () => {
    let embedCalls = 0;
    const client = makeClient(async () => {
      embedCalls++;
      return null;
    });

    await rescueEmbedPass(client, [], [], []);
    expect(embedCalls).toBe(0);
  });
});
