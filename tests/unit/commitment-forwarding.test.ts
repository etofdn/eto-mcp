import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// FN-090: verify that SubmitParams.commitment is forwarded through
// EtoRpcClient.sendTransaction and EtoRpcClient.getTransaction as the
// second positional JSON-RPC param (per Solana spec). Without this,
// polling times out when the devnet node only surfaces a tx at a higher
// commitment level than the node default (Issue #13, root-cause #4).

vi.mock("../../src/config.js", () => ({
  config: {
    etoRpcUrl: "http://localhost:8899",
    tx: {
      defaultTimeoutMs: 30_000,
      maxRetries: 0,
      confirmationPollMs: 50,
      maxPollErrors: 3,
    },
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  log: vi.fn(),
}));

import { EtoRpcClient } from "../../src/read/rpc-client.js";

function mockFetch(resultsByMethod: Record<string, any>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const result = resultsByMethod[body.method];
    if (result === undefined) {
      throw new Error(`Unmocked method: ${body.method}`);
    }
    return {
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
    } as Response;
  });
}

describe("EtoRpcClient commitment forwarding (FN-090)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedBodies: any[];

  beforeEach(() => {
    capturedBodies = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        capturedBodies.push(body);
        // Return a minimal valid response for each method
        const resultsByMethod: Record<string, any> = {
          sendTransaction: "5CwFakeSignature111111111111111111111111111111111111111111111",
          getTransaction: null, // null = not found yet (normal polling case)
        };
        const result = resultsByMethod[body.method] ?? null;
        return {
          ok: true,
          json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
        } as Response;
      },
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("sendTransaction omits config param when no commitment provided", async () => {
    const client = new EtoRpcClient("http://localhost:8899");
    await client.sendTransaction("AAAA==").catch(() => {}); // may throw due to invalid sig shape
    const call = capturedBodies.find((b) => b.method === "sendTransaction");
    expect(call).toBeDefined();
    // params should be [serializedTx] only — no second element
    expect(call.params).toHaveLength(1);
    expect(call.params[0]).toBe("AAAA==");
  });

  test("sendTransaction forwards commitment as second params element", async () => {
    const client = new EtoRpcClient("http://localhost:8899");
    await client
      .sendTransaction("AAAA==", { commitment: "finalized" })
      .catch(() => {}); // may throw due to invalid sig shape
    const call = capturedBodies.find((b) => b.method === "sendTransaction");
    expect(call).toBeDefined();
    expect(call.params).toHaveLength(2);
    expect(call.params[1]).toEqual({ commitment: "finalized" });
  });

  test("getTransaction omits config param when no commitment provided", async () => {
    const client = new EtoRpcClient("http://localhost:8899");
    // Use a valid base58 signature to pass signature validation
    const validSig = "5v4R4nFakeSignatureForTestingOnly111111111111111111111111111";
    await client.getTransaction(validSig).catch(() => {});
    const call = capturedBodies.find((b) => b.method === "getTransaction");
    expect(call).toBeDefined();
    expect(call.params).toHaveLength(1);
    expect(call.params[0]).toBe(validSig);
  });

  test("getTransaction forwards commitment as second params element", async () => {
    const client = new EtoRpcClient("http://localhost:8899");
    const validSig = "5v4R4nFakeSignatureForTestingOnly111111111111111111111111111";
    await client.getTransaction(validSig, { commitment: "confirmed" }).catch(() => {});
    const call = capturedBodies.find((b) => b.method === "getTransaction");
    expect(call).toBeDefined();
    expect(call.params).toHaveLength(2);
    expect(call.params[1]).toEqual({ commitment: "confirmed" });
  });

  test("getTransaction forwards 'submitted' commitment level", async () => {
    const client = new EtoRpcClient("http://localhost:8899");
    const validSig = "5v4R4nFakeSignatureForTestingOnly111111111111111111111111111";
    await client.getTransaction(validSig, { commitment: "submitted" }).catch(() => {});
    const call = capturedBodies.find((b) => b.method === "getTransaction");
    expect(call.params[1]).toEqual({ commitment: "submitted" });
  });
});
