import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FN-043 query_memos integration coverage.
 *
 * tests/memo/query-decode.test.ts (FN-041) covers a 3-record case: one valid
 * payment, one not_json, one unknown_future_version. This file EXTENDS that
 * coverage with:
 *
 *   - A 5-record mixed batch (valid eval_score, valid payment, malformed
 *     JSON, future-version envelope, payload-validation failure) — none
 *     dropped, none thrown out of the handler.
 *   - filter_field/filter_value semantics in the presence of malformed
 *     records (the malformed memo must NOT match a JSON-field filter, and
 *     the matching record must round-trip verbatim).
 *   - A defensive case where decodeMemo is hot-swapped to return an
 *     unexpected shape — the handler still returns a response object.
 */

const etoGetAccountTransactions = vi.fn();
const etoGetTransaction = vi.fn();

vi.mock("../../../src/read/rpc-client.js", () => ({
  rpc: {
    etoGetAccountTransactions: (...a: any[]) => etoGetAccountTransactions(...a),
    etoGetTransaction: (...a: any[]) => etoGetTransaction(...a),
  },
}));

vi.mock("../../../src/utils/units.js", () => ({
  lamportsToSol: (l: bigint) => String(Number(l) / 1e9),
}));

vi.mock("../../../src/utils/address.js", () => ({
  detectAddressType: () => "svm",
}));

import { registerQueryTools } from "../../../src/tools/query.js";
import { encodeMemo } from "../../../src/memo/index.js";
import * as memoModule from "../../../src/memo/index.js";
import {
  minimalEvalScorePayload,
  minimalPaymentPayload,
} from "./fixtures.js";

interface ToolHandler {
  (args: any): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function makeServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tool(name: string, _desc: string, _schema: any, handler: ToolHandler) {
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

const ADDRESS = "Acct11111111111111111111111111111111111111";

beforeEach(() => {
  etoGetAccountTransactions.mockReset();
  etoGetTransaction.mockReset();
  vi.restoreAllMocks();
});

describe("query_memos — mixed valid + invalid memos", () => {
  it("returns ALL records (valid + invalid) without throwing on a single bad memo", async () => {
    const evalScorePayload = minimalEvalScorePayload();
    const paymentPayload = minimalPaymentPayload();
    const validEvalRaw = encodeMemo("eval_score", evalScorePayload);
    const validPayRaw = encodeMemo("payment", paymentPayload);
    const malformedRaw = "{not-json";
    const futureRaw = JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v9",
      v: 9,
      ts: "2026-05-02T17:00:00Z",
      payload: { whatever: true },
    });
    // Payload that fails validation against the registered schema (purpose
    // is not in the enum).
    const payloadInvalidRaw = JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: "2026-05-02T17:00:00Z",
      payload: { purpose: "not-an-enum-value", invoice_id: "i-bad" },
    });

    etoGetAccountTransactions.mockResolvedValue([
      { signature: "sig-eval", blockTime: 1, logs: memoLogsFor(validEvalRaw) },
      { signature: "sig-pay", blockTime: 2, logs: memoLogsFor(validPayRaw) },
      { signature: "sig-bad", blockTime: 3, logs: memoLogsFor(malformedRaw) },
      { signature: "sig-future", blockTime: 4, logs: memoLogsFor(futureRaw) },
      { signature: "sig-payload-invalid", blockTime: 5, logs: memoLogsFor(payloadInvalidRaw) },
    ]);

    const server = makeServer();
    registerQueryTools(server as any);

    let result: any;
    await expect(
      (async () => {
        result = await server.invoke("query_memos", { address: ADDRESS });
      })(),
    ).resolves.not.toThrow();

    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(5);

    const bySig: Record<string, any> = {};
    for (const r of body.records) bySig[r.sig] = r;

    // Valid eval_score round-trips.
    expect(bySig["sig-eval"].decoded.ok).toBe(true);
    expect(bySig["sig-eval"].decoded.envelope.schema).toBe("eto.memo.eval_score.v1");
    expect(bySig["sig-eval"].decoded.envelope.payload).toEqual(evalScorePayload);
    expect(bySig["sig-eval"].raw).toBe(validEvalRaw);

    // Valid payment round-trips.
    expect(bySig["sig-pay"].decoded.ok).toBe(true);
    expect(bySig["sig-pay"].decoded.envelope.schema).toBe("eto.memo.payment.v1");
    expect(bySig["sig-pay"].raw).toBe(validPayRaw);

    // Invalid records preserve raw verbatim and surface the precise reason.
    expect(bySig["sig-bad"].decoded.ok).toBe(false);
    expect(bySig["sig-bad"].decoded.reason).toBe("not_json");
    expect(bySig["sig-bad"].raw).toBe(malformedRaw);

    expect(bySig["sig-future"].decoded.ok).toBe(false);
    expect(bySig["sig-future"].decoded.reason).toBe("unknown_future_version");
    expect(bySig["sig-future"].raw).toBe(futureRaw);

    expect(bySig["sig-payload-invalid"].decoded.ok).toBe(false);
    expect(bySig["sig-payload-invalid"].decoded.reason).toBe("payload_invalid");
    expect(bySig["sig-payload-invalid"].raw).toBe(payloadInvalidRaw);
  });

  it("filter_field/filter_value still selects on parsed JSON top-level fields and excludes malformed memos", async () => {
    const evalScorePayload = minimalEvalScorePayload();
    const validEvalRaw = encodeMemo("eval_score", evalScorePayload);
    const validPayRaw = encodeMemo("payment", minimalPaymentPayload());
    const malformedRaw = "{still-not-json";

    etoGetAccountTransactions.mockResolvedValue([
      { signature: "sig-eval", blockTime: 1, logs: memoLogsFor(validEvalRaw) },
      { signature: "sig-pay", blockTime: 2, logs: memoLogsFor(validPayRaw) },
      { signature: "sig-bad", blockTime: 3, logs: memoLogsFor(malformedRaw) },
    ]);

    const server = makeServer();
    registerQueryTools(server as any);

    // The eval_score envelope's top-level `type` field is "eval_score".
    // matchesFilter compares against the parsed memo (the envelope object,
    // since the raw memo is the envelope JSON). Filtering on type === eval_score
    // should keep only the eval record. The malformed memo is parsed as a
    // raw string by parseMemoPayload and therefore CANNOT match a JSON
    // field filter — that's the regression we're locking down.
    const result = await server.invoke("query_memos", {
      address: ADDRESS,
      filter_field: "type",
      filter_value: "eval_score",
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.count).toBe(1);
    expect(body.records[0].sig).toBe("sig-eval");
    expect(body.records[0].decoded.ok).toBe(true);

    // Sanity: the malformed sig is excluded.
    const sigs = body.records.map((r: any) => r.sig);
    expect(sigs).not.toContain("sig-bad");
    expect(sigs).not.toContain("sig-pay");
  });

  it("returns a response object even if decodeMemo somehow returns an unexpected shape", async () => {
    const validRaw = encodeMemo("payment", minimalPaymentPayload());
    etoGetAccountTransactions.mockResolvedValue([
      { signature: "sig-1", blockTime: 1, logs: memoLogsFor(validRaw) },
    ]);

    // Force decodeMemo to return a corrupt result. The handler must still
    // produce a content array — never re-throw.
    vi.spyOn(memoModule, "decodeMemo").mockReturnValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { unexpected: true } as any,
    );

    const server = makeServer();
    registerQueryTools(server as any);

    let result: any;
    await expect(
      (async () => {
        result = await server.invoke("query_memos", { address: ADDRESS });
      })(),
    ).resolves.not.toThrow();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    // Body is JSON-parseable.
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
