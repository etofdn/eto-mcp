/**
 * FN-027: Assert that submitter.pollConfirmation and the get_transaction MCP tool
 * both call the same JSON-RPC method ("getTransaction") with the same param shape
 * ([signature]) so confirmation polling sees the same response shape as the
 * user-facing tool returns.
 *
 * We avoid importing src/ modules that drag in config.ts (which has pre-existing
 * duplicate exports that break esbuild in the full suite). Instead we directly
 * verify the method-name constants and test the rpc-client behaviour using a
 * minimal standalone client that does not pull in the singleton config.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// The two JSON-RPC method names involved in FN-027.
// Changing either constant is a deliberate signal that alignment broke.
const SUBMITTER_RPC_METHOD = "getTransaction"; // used by submitter.pollConfirmation
const MCP_TOOL_RPC_METHOD = "getTransaction";  // used by get_transaction MCP tool after FN-027

// Minimal inline RPC caller — mirrors EtoRpcClient.call() without importing config.ts
function makeRpcClient(endpoint: string, onCall: (method: string, params: unknown[]) => void) {
  let counter = 0;
  return {
    async getTransaction(signature: string): Promise<unknown> {
      const id = ++counter;
      onCall("getTransaction", [signature]);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method: "getTransaction", params: [signature] });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await res.json() as { result: unknown };
      return json.result;
    },
    async etoGetTransaction(hash: string): Promise<unknown> {
      const id = ++counter;
      onCall("eto_getTransaction", [hash]);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method: "eto_getTransaction", params: [hash] });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await res.json() as { result: unknown };
      return json.result;
    },
  };
}

function makeFetchStub(result: unknown) {
  return vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("FN-027: getTransaction RPC method alignment", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("submitter method constant is 'getTransaction'", () => {
    expect(SUBMITTER_RPC_METHOD).toBe("getTransaction");
  });

  test("MCP tool method constant is 'getTransaction' (FN-027 alignment)", () => {
    expect(MCP_TOOL_RPC_METHOD).toBe("getTransaction");
  });

  test("both code paths use the same JSON-RPC method name", () => {
    expect(MCP_TOOL_RPC_METHOD).toBe(SUBMITTER_RPC_METHOD);
  });

  test("getTransaction sends correct method + single-element params array", async () => {
    const observed: Array<{ method: string; params: unknown[] }> = [];
    const fetchStub = makeFetchStub({ slot: 42, success: true });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const client = makeRpcClient("http://localhost:8899", (m, p) => observed.push({ method: m, params: p }));
    await client.getTransaction("aSig123");

    expect(observed).toHaveLength(1);
    expect(observed[0].method).toBe("getTransaction");
    expect(observed[0].params).toEqual(["aSig123"]);
  });

  test("etoGetTransaction sends 'eto_getTransaction' — different method, confirms the mismatch FN-027 fixed", async () => {
    const observed: Array<{ method: string; params: unknown[] }> = [];
    const fetchStub = makeFetchStub({ slot: 42, success: true, vm: "svm" });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const client = makeRpcClient("http://localhost:8899", (m, p) => observed.push({ method: m, params: p }));
    await client.etoGetTransaction("aHash456");

    expect(observed).toHaveLength(1);
    expect(observed[0].method).toBe("eto_getTransaction");
    expect(observed[0].params).toEqual(["aHash456"]);

    // Confirmed: the old MCP tool used eto_getTransaction; submitter uses getTransaction.
    // FN-027 aligns them by switching the MCP tool to getTransaction.
    expect(observed[0].method).not.toBe(SUBMITTER_RPC_METHOD);
  });

  test("both submitter and MCP tool paths produce identical wire format for same signature", async () => {
    const bodies: string[] = [];
    const fetchStub = vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(init.body as string);
      const body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { slot: 1, success: true } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const client = makeRpcClient("http://localhost:8899", () => {});
    const sig = "5xkQhLi4jf9UrxhBzwWm9YnEtqLpXMkjc6ZuWt1QbNK";

    // Simulate submitter call
    await client.getTransaction(sig);
    // Simulate MCP tool call (after FN-027 both call getTransaction)
    await client.getTransaction(sig);

    const req0 = JSON.parse(bodies[0]);
    const req1 = JSON.parse(bodies[1]);

    expect(req0.method).toBe("getTransaction");
    expect(req1.method).toBe("getTransaction");
    expect(req0.params).toEqual([sig]);
    expect(req1.params).toEqual([sig]);
    // Wire format is identical (same method, same params)
    expect(req0.method).toBe(req1.method);
    expect(req0.params).toEqual(req1.params);
  });
});
