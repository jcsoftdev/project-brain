import { describe, it, expect, mock } from "bun:test";
import { resolveEmbedConfigAsync } from "../../src/commands/sync.js";
import type { EmbedTuning } from "../../src/embeddings/auto-tune.js";

function fakeDetect(tuning: EmbedTuning) {
  return mock(async (_host: string, _embedModel: string) => tuning);
}

describe("resolveEmbedConfigAsync — precedence: env > runtime auto-detect > static defaults", () => {
  it("both env vars set → skips detection entirely (no probe)", async () => {
    const detect = fakeDetect({ batchSize: 16, concurrency: 1, reason: "vram-contention" });

    const config = await resolveEmbedConfigAsync(
      { BRAIN_EMBED_BATCH_SIZE: "128", BRAIN_EMBED_CONCURRENCY: "8" },
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      detect
    );

    expect(config).toEqual({ batchSize: 128, concurrency: 8 });
    expect(detect).not.toHaveBeenCalled();
  });

  it("only BRAIN_EMBED_BATCH_SIZE set → detected concurrency fills the gap, env batchSize wins", async () => {
    const detect = fakeDetect({ batchSize: 32, concurrency: 1, reason: "low-memory" });

    const config = await resolveEmbedConfigAsync(
      { BRAIN_EMBED_BATCH_SIZE: "128" },
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      detect
    );

    expect(config.batchSize).toBe(128); // env wins
    expect(config.concurrency).toBe(1); // detected fills the gap
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("only BRAIN_EMBED_CONCURRENCY set → detected batchSize fills the gap, env concurrency wins", async () => {
    const detect = fakeDetect({ batchSize: 16, concurrency: 1, reason: "vram-contention" });

    const config = await resolveEmbedConfigAsync(
      { BRAIN_EMBED_CONCURRENCY: "8" },
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      detect
    );

    expect(config.batchSize).toBe(16); // detected fills the gap
    expect(config.concurrency).toBe(8); // env wins
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("neither env var set → detected values win over static defaults", async () => {
    const detect = fakeDetect({ batchSize: 32, concurrency: 1, reason: "low-memory" });

    const config = await resolveEmbedConfigAsync(
      {},
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      detect
    );

    expect(config).toEqual({ batchSize: 32, concurrency: 1 });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("neither env var set and detection reports plain defaults → matches static defaults", async () => {
    const detect = fakeDetect({ batchSize: 64, concurrency: 3, reason: "default cores=12" });

    const config = await resolveEmbedConfigAsync(
      {},
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      detect
    );

    expect(config).toEqual({ batchSize: 64, concurrency: 3 });
  });
});
