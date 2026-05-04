/**
 * Vitest unit tests for `EtoRpcClient.faucet()` response validation (FN-197).
 *
 * Closes the FN-097 error-masking case where `JSON.stringify(result)` was
 * returned as a fallback, turning rate-limit / mock-faucet error payloads
 * into strings that callers treated as real signatures.
 *
 * NOTE: `src/config.ts` currently has multiple duplicate `export const config`
 * declarations (tracked by FN-062 / FN-066) that cause esbuild to refuse to
 * transform the file. We work around that here by stubbing the config module
 * via `vi.mock` rather than importing the real one. Do NOT dedupe config.ts
 * as part of FN-197 — that is explicitly out of scope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted by vitest before the rpc-client import below.
vi.mock("../../src/config.js", () => ({
  config: {
    etoRpcUrl: "http://stub",
    tx: {
      blockhashRefreshMs: 20_000,
      blockhashValidityMs: 60_000,
      defaultTimeoutMs: 30_000,
      maxRetries: 3,
      confirmationPollMs: 1,
      maxPollErrors: 3,
    },
    logLevel: "error",
  },
}));

// Silence the rpc-client's debug logger so test output stays readable.
vi.mock("../../src/utils/logger.js", () => ({
  log: () => {},
}));

import { EtoRpcClient } from "../../src/read/rpc-client.js";

/* -------------------------------------------------------------------------- */
/* Fetch stubbing helpers                                                     */
/* -------------------------------------------------------------------------- */

function stubFetch(jsonBody: unknown, ok = true, status = 200): void {
  const fakeResponse = {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => jsonBody,
  } as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async () => fakeResponse));
}

/** A real-shaped 88-char base58 signature (Solana mainnet length). */
const REAL_SIG_88 =
  "5J7s" + "k".repeat(84); // 88 chars, all base58 alphabet

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("EtoRpcClient.faucet — FN-197 response validation", () => {
  let client: EtoRpcClient;

  beforeEach(() => {
    client = new EtoRpcClient("http://stub");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves to a real-looking 88-char base58 signature when result.signature is set", async () => {
    stubFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { signature: REAL_SIG_88 },
    });
    await expect(client.faucet("addr", 1)).resolves.toBe(REAL_SIG_88);
  });

  it("rejects when result is the FN-097 rate-limit error shape (no .signature, no error field)", async () => {
    // This is the exact masking case FN-197 closes: the legacy code did
    // `JSON.stringify(result)` and returned that as a "signature".
    stubFetch({
      jsonrpc: "2.0",
      id: 1,
      result: { code: -32600, message: "rate limit" },
    });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /faucet returned non-signature/,
    );
  });

  it("rejects via the call()-level guard when result is null", async () => {
    // The current implementation classifies `null` as a non-signature at
    // the faucet validator level (the call-level guard only fires on
    // `undefined`). Either way, callers must not see a phantom value.
    stubFetch({ jsonrpc: "2.0", id: 1, result: null });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /faucet returned non-signature/,
    );
  });

  it("rejects when the response has neither result nor error (FN-198 call() guard)", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1 });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /has neither result nor error field/,
    );
  });

  it("rejects with a JSON-RPC error message when error is set", async () => {
    stubFetch({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /JSON-RPC error -32601/,
    );
  });

  it("rejects a hex-looking 64-char string (proves the hex branch was removed)", async () => {
    // 64 zeros — '0' is NOT in the base58 alphabet (excluded chars: 0/O/I/l)
    // so this string is unambiguously hex-only and must fail validation.
    const hex64 = "0".repeat(64);
    stubFetch({ jsonrpc: "2.0", id: 1, result: hex64 });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /faucet returned non-signature/,
    );
  });

  it("rejects a 12-char base58 string (below the 43-char floor)", async () => {
    const tooShort = "5".repeat(12);
    stubFetch({ jsonrpc: "2.0", id: 1, result: tooShort });
    await expect(client.faucet("addr", 1)).rejects.toThrow(
      /faucet returned non-signature/,
    );
  });

  it("accepts a string `result` that is itself a valid 88-char base58 signature", async () => {
    // Sanity check: the candidate ?? chain falls through to
    // `typeof result === \"string\" ? result : null`.
    stubFetch({ jsonrpc: "2.0", id: 1, result: REAL_SIG_88 });
    await expect(client.faucet("addr", 1)).resolves.toBe(REAL_SIG_88);
  });
});
