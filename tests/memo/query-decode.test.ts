import { describe, it, expect, vi, beforeEach } from "vitest";

const etoGetAccountTransactions = vi.fn();
const etoGetTransaction = vi.fn();

vi.mock("../../src/read/rpc-client.js", () => ({
  rpc: {
    etoGetAccountTransactions: (...a: any[]) => etoGetAccountTransactions(...a),
    etoGetTransaction: (...a: any[]) => etoGetTransaction(...a),
  },
}));

vi.mock("../../src/utils/units.js", () => ({
  lamportsToSol: (l: bigint) => String(Number(l) / 1e9),
}));

vi.mock("../../src/utils/address.js", () => ({
  detectAddressType: () => "svm",
}));

import { registerQueryTools } from "../../src/tools/query.js";
import { encodeMemo } from "../../src/memo/index.js";

function makeServer() {
  const tools = new Map<string, (args: any) => Promise<any>>();
  return {
    tool(name: string, _desc: string, _schema: any, handler: any) {
      tools.set(name, handler);
    },
    invoke(name: string, args: any) {
      const h = tools.get(name);
      if (!h) throw new Error(`tool ${name} not registered`);
      return h(args);
    },
  };
}

function memoLogsFor(raw: string): string[] {
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]",
    `Program log: Memo (len ${Buffer.byteLength(raw, "utf8")}): "${escaped}"`,
    "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success",
  ];
}

beforeEach(() => {
  etoGetAccountTransactions.mockReset();
  etoGetTransaction.mockReset();
});

describe("query_memos decoded shape", () => {
  it("returns { raw, decoded } for valid, malformed, and future-version memos", async () => {
    const validRaw = encodeMemo("payment", { purpose: "service", invoice_id: "i-1" });
    const malformedRaw = "{not-json";
    const futureRaw = JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v9",
      v: 9,
      ts: "2026-05-02T17:00:00Z",
      payload: { whatever: true },
    });

    etoGetAccountTransactions.mockResolvedValue([
      { signature: "sig-valid", blockTime: 1, logs: memoLogsFor(validRaw) },
      { signature: "sig-bad", blockTime: 2, logs: memoLogsFor(malformedRaw) },
      { signature: "sig-future", blockTime: 3, logs: memoLogsFor(futureRaw) },
    ]);

    const server = makeServer();
    registerQueryTools(server as any);

    const result = await server.invoke("query_memos", {
      address: "Acct11111111111111111111111111111111111111",
    });

    expect(result.content[0].type).toBe("text");
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(3);

    const bySig: Record<string, any> = {};
    for (const r of body.records) bySig[r.sig] = r;

    expect(bySig["sig-valid"].decoded.ok).toBe(true);
    expect(bySig["sig-valid"].decoded.envelope.schema).toBe("eto.memo.payment.v1");
    expect(bySig["sig-valid"].raw).toBe(validRaw);

    expect(bySig["sig-bad"].decoded.ok).toBe(false);
    expect(bySig["sig-bad"].decoded.reason).toBe("not_json");

    expect(bySig["sig-future"].decoded.ok).toBe(false);
    expect(bySig["sig-future"].decoded.reason).toBe("unknown_future_version");
  });

  it("does not throw if the RPC returns no logs", async () => {
    etoGetAccountTransactions.mockResolvedValue([
      { signature: "sig-empty", blockTime: 1, logs: [] },
    ]);

    const server = makeServer();
    registerQueryTools(server as any);

    const result = await server.invoke("query_memos", {
      address: "Acct11111111111111111111111111111111111111",
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(0);
  });
});
