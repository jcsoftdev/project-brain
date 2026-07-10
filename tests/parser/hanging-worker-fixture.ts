// Test-only worker fixture for pool.test.ts's probe-timeout regression
// coverage. This script IS a valid, loadable worker module (so Bun's
// `Worker` constructor never fires `onerror` for it) but deliberately never
// responds to any `postMessage` — including ParserPool's confirmation
// probe. It exists to prove `ParserPool.spawnSlot`'s `CANDIDATE_TIMEOUT_MS`
// fallback fires even when a candidate never errors, only hangs.
self.onmessage = () => {
  // Intentionally does nothing — never posts a response.
};
