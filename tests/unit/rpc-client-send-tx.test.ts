/**
 * Unit tests for `EtoRpcClient.sendTransaction()` and
 * `EtoRpcClient.ethSendRawTransaction()` response validation (FN-089).
 *
 * Mirrors the FN-197/198 faucet validation pattern: a misbehaving devnet node
 * returning a non-signature string must be caught here, before the value
 * propagates into `submitter.pollConfirmation` and surfaces as a spurious
 * "not found" / timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/utils/logger.js", () => ({
  log: () => {},
}));

import { EtoRpcClient } from "../../src/read/rpc-client.js";

function stubFetch(jsonBody: unknown, ok = true): void {
  const fakeResponse = {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => jsonBody,
  } as unknown as Response;
  vi.stubGlobal("fetch", vi.fn(async () => fakeResponse));
}

/** Valid 88-char base58 signature (Solana mainnet length). */
const REAL_SIG_88 = "5J7s" + "k".repeat(84); // 88 chars, all base58 alphabet

/** Valid EVM tx hash: 0x + 64 hex chars. */
const REAL_EVM_HASH = "0x" + "a".repeat(64);

describe("EtoRpcClient.sendTransaction — FN-089 signature validation", () => {
  let client: EtoRpcClient;

  beforeEach(() => {
    client = new EtoRpcClient("http://stub");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves to a valid base58 signature when the node returns one", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: REAL_SIG_88 });
    await expect(client.sendTransaction("encoded-tx")).resolves.toBe(REAL_SIG_88);
  });

  it("rejects when the node returns a short non-signature string", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: "not-a-real-sig" });
    await expect(client.sendTransaction("encoded-tx")).rejects.toThrow(
      /sendTransaction returned non-signature/,
    );
  });

  it("rejects when the node returns an error-shaped object (FN-097 masking case)", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: { code: -32600, message: "rate limit" } });
    await expect(client.sendTransaction("encoded-tx")).rejects.toThrow(
      /sendTransaction returned non-signature/,
    );
  });

  it("rejects when the node returns a hex string (non-SVM mock smell)", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: "0".repeat(64) });
    await expect(client.sendTransaction("encoded-tx")).rejects.toThrow(
      /sendTransaction returned non-signature/,
    );
  });

  it("propagates the call()-level guard when result is undefined", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1 });
    await expect(client.sendTransaction("encoded-tx")).rejects.toThrow(
      /has neither result nor error field/,
    );
  });
});

describe("EtoRpcClient.ethSendRawTransaction — FN-089 hash validation", () => {
  let client: EtoRpcClient;

  beforeEach(() => {
    client = new EtoRpcClient("http://stub");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves to a valid 0x+64hex hash when the node returns one", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: REAL_EVM_HASH });
    await expect(client.ethSendRawTransaction("0xsignedtx")).resolves.toBe(REAL_EVM_HASH);
  });

  it("rejects when the node returns a bare hex string without 0x prefix", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: "a".repeat(64) });
    await expect(client.ethSendRawTransaction("0xsignedtx")).rejects.toThrow(
      /eth_sendRawTransaction returned non-hash/,
    );
  });

  it("rejects when the node returns a truncated hash", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: "0x" + "a".repeat(32) });
    await expect(client.ethSendRawTransaction("0xsignedtx")).rejects.toThrow(
      /eth_sendRawTransaction returned non-hash/,
    );
  });

  it("rejects an error-shaped object (masking case)", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1, result: { error: "nonce too low" } });
    await expect(client.ethSendRawTransaction("0xsignedtx")).rejects.toThrow(
      /eth_sendRawTransaction returned non-hash/,
    );
  });

  it("propagates the call()-level guard when result is undefined", async () => {
    stubFetch({ jsonrpc: "2.0", id: 1 });
    await expect(client.ethSendRawTransaction("0xsignedtx")).rejects.toThrow(
      /has neither result nor error field/,
    );
  });
});
