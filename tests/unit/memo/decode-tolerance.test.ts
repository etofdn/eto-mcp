import { describe, it, expect } from "vitest";
import { decodeMemo } from "../../../src/memo/index.js";
import type { DecodeFailureReason } from "../../../src/memo/index.js";

/**
 * FN-043 decodeMemo tolerance coverage.
 *
 * docs/memo-schema-registry.md §5 promises decodeMemo NEVER throws — every
 * malformed input surfaces as `{ ok: false, reason, raw }`. This file
 * exhaustively walks the failure surface so a regression in the JSON parse
 * try/catch, Ajv invocation, or registry lookup cannot reintroduce throws
 * without breaking a test.
 *
 * Every case asserts both:
 *   1. `expect(() => decodeMemo(input)).not.toThrow()` — the contract.
 *   2. The precise `reason` string returned, plus `raw` echo.
 */

const ISO_TS = "2026-05-02T17:00:00Z";

interface Case {
  name: string;
  input: string;
  reason: DecodeFailureReason;
}

const cases: Case[] = [
  { name: "empty string", input: "", reason: "not_json" },
  { name: "truncated JSON brace", input: "{", reason: "not_json" },
  { name: "plain non-JSON text", input: "hello world", reason: "not_json" },
  { name: "valid JSON array", input: "[]", reason: "envelope_invalid" },
  {
    name: "envelope missing payload",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: ISO_TS,
    }),
    reason: "envelope_invalid",
  },
  {
    name: "envelope missing ts",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      payload: { purpose: "service", invoice_id: "i-1" },
    }),
    reason: "envelope_invalid",
  },
  {
    name: "envelope ts is not a date-time",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: "not-a-date",
      payload: { purpose: "service", invoice_id: "i-1" },
    }),
    reason: "envelope_invalid",
  },
  {
    name: "envelope v is below minimum:1",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 0,
      ts: ISO_TS,
      payload: { purpose: "service", invoice_id: "i-1" },
    }),
    reason: "envelope_invalid",
  },
  {
    name: "envelope v is non-integer",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1.5,
      ts: ISO_TS,
      payload: { purpose: "service", invoice_id: "i-1" },
    }),
    reason: "envelope_invalid",
  },
  {
    name: "envelope has additionalProperties",
    input: JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: ISO_TS,
      payload: { purpose: "service", invoice_id: "i-1" },
      extra: "nope",
    }),
    reason: "envelope_invalid",
  },
  {
    name: "eval_score payload missing required `score`",
    input: JSON.stringify({
      type: "eval_score",
      schema: "eto.memo.eval_score.v1",
      v: 1,
      ts: ISO_TS,
      payload: {
        subject: "did:eto:agent:a",
        metric: "helpfulness",
        // score omitted
        evaluator: "did:eto:eval:b",
      },
    }),
    reason: "payload_invalid",
  },
  {
    name: "eval_score payload score out of [0,1] range",
    input: JSON.stringify({
      type: "eval_score",
      schema: "eto.memo.eval_score.v1",
      v: 1,
      ts: ISO_TS,
      payload: {
        subject: "did:eto:agent:a",
        metric: "helpfulness",
        score: 1.5,
        evaluator: "did:eto:eval:b",
      },
    }),
    reason: "payload_invalid",
  },
];

describe("decodeMemo — exhaustive malformed-input tolerance", () => {
  for (const c of cases) {
    it(`${c.name} → ${c.reason}, never throws, preserves raw`, () => {
      // Two assertions intentionally — the .not.toThrow() invokes decodeMemo
      // a second time, which is the cheapest way to express "really, never
      // throws" without polluting the result variable.
      expect(() => decodeMemo(c.input)).not.toThrow();
      const r = decodeMemo(c.input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe(c.reason);
      expect(r.raw).toBe(c.input);
    });
  }

  it("does not throw on non-string inputs and returns ok:false", () => {
    // Producers SHOULD always pass strings, but we cast through `unknown` to
    // exercise the defensive try/catch wrapping decodeMemo's body. Reason
    // can be either `not_json` or `envelope_invalid` depending on how
    // JSON.parse interprets the coerced value — we only assert ok:false.
    let undefResult;
    expect(() => {
      undefResult = decodeMemo(undefined as unknown as string);
    }).not.toThrow();
    expect(undefResult!.ok).toBe(false);

    let nullResult;
    expect(() => {
      nullResult = decodeMemo(null as unknown as string);
    }).not.toThrow();
    expect(nullResult!.ok).toBe(false);
  });
});
