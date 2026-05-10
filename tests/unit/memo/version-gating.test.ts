import { describe, it, expect } from "vitest";
import { decodeMemo } from "../../../src/memo/index.js";

/**
 * FN-043 §6 version-gating coverage.
 *
 * docs/memo-schema-registry.md §6 dictates that decodeMemo must distinguish:
 *
 *   - known schema + known v             → ok: true
 *   - known <type>, v exceeds registry   → ok: false, reason: unknown_future_version
 *   - unknown <type> entirely            → ok: false, reason: unknown_schema
 *   - envelope.type ≠ <type> from schema → ok: false, reason: type_schema_mismatch
 *
 * None of these cases may throw. This file complements the spot-check
 * coverage in tests/memo/encode-decode.test.ts by asserting EACH §6 branch
 * end-to-end with hand-built envelopes (so the test does not depend on
 * encodeMemo's own schema/v normalisation).
 */

const ISO_TS = "2026-05-02T17:00:00Z";

function envelopeJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    type: "payment",
    schema: "eto.memo.payment.v1",
    v: 1,
    ts: ISO_TS,
    payload: { purpose: "service", invoice_id: "i-1" },
    ...over,
  });
}

describe("decodeMemo — version gating (§6)", () => {
  it("accepts a hand-built v1 envelope for a registered schema", () => {
    const raw = envelopeJson({});
    const r = decodeMemo(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.v).toBe(1);
    expect(r.envelope.schema).toBe("eto.memo.payment.v1");
  });

  it("returns unknown_future_version (not a throw) when v exceeds the registry's highest known version for a known type", () => {
    // §6: known <type> 'eval_score' exists at v1; producer-supplied v999 must
    // round-trip back as `unknown_future_version` so consumers can apply
    // forward-compat heuristics rather than crashing the whole call.
    const raw = JSON.stringify({
      type: "eval_score",
      schema: "eto.memo.eval_score.v999",
      v: 999,
      ts: ISO_TS,
      payload: { whatever: true },
    });

    let r;
    expect(() => {
      r = decodeMemo(raw);
    }).not.toThrow();
    expect(r!.ok).toBe(false);
    if (r!.ok) return;
    expect(r!.reason).toBe("unknown_future_version");
    expect(r!.raw).toBe(raw);
  });

  it("returns unknown_schema when the <type> segment is not in the registry at all", () => {
    const raw = JSON.stringify({
      type: "fictitious",
      schema: "eto.memo.fictitious.v1",
      v: 1,
      ts: ISO_TS,
      payload: {},
    });
    const r = decodeMemo(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_schema");
    expect(r.raw).toBe(raw);
  });

  it("returns type_schema_mismatch when envelope.type contradicts the <type> segment of envelope.schema", () => {
    const raw = JSON.stringify({
      type: "payment",
      schema: "eto.memo.eval_score.v1",
      v: 1,
      ts: ISO_TS,
      payload: { purpose: "service", invoice_id: "i-1" },
    });
    const r = decodeMemo(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("type_schema_mismatch");
    expect(r.raw).toBe(raw);
  });

  // Forward-compat scenario.
  //
  // FN-041 ships only v1 schemas, so a producer-supplied v2 of a known type
  // (e.g. `eto.memo.payment.v2`) MUST currently surface as
  // `unknown_future_version` per §6 ("highest known v ≤ producer.v" rule).
  //
  // When v2 is registered in `src/memo/registry.ts`, this assertion will
  // flip to `ok: true` — that's intentional and proves the §6 rule still
  // holds. If you're reading this comment because the test now fails after
  // adding v2, update the expectation to `ok: true` rather than papering
  // over the registry change.
  it("forward-compat — v2 of a known type is opaque while only v1 is registered", () => {
    const raw = JSON.stringify({
      type: "payment",
      schema: "eto.memo.payment.v2",
      v: 2,
      ts: ISO_TS,
      payload: { purpose: "service", invoice_id: "i-1" },
    });
    const r = decodeMemo(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_future_version");
  });
});
