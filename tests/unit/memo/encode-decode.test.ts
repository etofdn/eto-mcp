import { describe, it, expect, vi, afterEach } from "vitest";
import {
  encodeMemo,
  decodeMemo,
  byteLengthUtf8,
  MEMO_HARD_LIMIT_BYTES,
  MEMO_SOFT_WARN_BYTES,
} from "../../../src/memo/index.js";
import {
  minimalEvalScorePayload,
  minimalPaymentPayload,
  minimalCoordinationLogPayload,
  fullEvalScorePayload,
} from "./fixtures.js";

/**
 * FN-043 round-trip + byte-budget coverage.
 *
 * Locks down docs/memo-schema-registry.md §2 (envelope shape, byte budget),
 * §4 (the three v1 payload schemas), and §5 (encodeMemo/decodeMemo
 * round-trip contract). Complements tests/memo/encode-decode.test.ts (which
 * covers a single happy path per type plus failure-shape spot checks) by
 * proving the EXACT envelope shape and adding boundary cases for the soft
 * warn / hard limit thresholds.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

interface EnvelopeShape {
  type: string;
  schema: string;
  v: number;
  ts: string;
  payload: unknown;
}

function assertEnvelopeShape(parsed: unknown, type: string): EnvelopeShape {
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  const env = parsed as EnvelopeShape;
  expect(env.type).toBe(type);
  expect(env.schema).toBe(`eto.memo.${type}.v1`);
  expect(env.v).toBe(1);
  expect(typeof env.ts).toBe("string");
  // ts must be parseable as a real RFC 3339 / ISO 8601 timestamp.
  expect(Number.isFinite(Date.parse(env.ts))).toBe(true);
  expect(env.payload).toBeTypeOf("object");
  return env;
}

describe("encodeMemo / decodeMemo — per-schema round-trips", () => {
  const cases: Array<{ type: string; payload: () => Record<string, unknown> }> = [
    { type: "eval_score", payload: minimalEvalScorePayload },
    { type: "payment", payload: minimalPaymentPayload },
    { type: "coordination_log", payload: minimalCoordinationLogPayload },
  ];

  for (const c of cases) {
    it(`round-trips a minimal-valid ${c.type} envelope and exposes the canonical envelope shape`, () => {
      const payload = c.payload();
      const raw = encodeMemo(c.type, payload);

      // The encoder always emits a string.
      expect(typeof raw).toBe("string");

      // The string parses as JSON with the exact envelope shape required by §2.
      const parsed = JSON.parse(raw);
      const env = assertEnvelopeShape(parsed, c.type);
      expect(env.payload).toEqual(payload);

      // decodeMemo reverses encodeMemo losslessly.
      const decoded = decodeMemo(raw);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.envelope.type).toBe(c.type);
      expect(decoded.envelope.schema).toBe(`eto.memo.${c.type}.v1`);
      expect(decoded.envelope.v).toBe(1);
      expect(decoded.envelope.payload).toEqual(payload);
    });
  }

  it("round-trips an eval_score envelope with every optional field populated", () => {
    const payload = fullEvalScorePayload();
    const raw = encodeMemo("eval_score", payload);
    const decoded = decodeMemo(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.payload).toEqual(payload);
  });
});

describe("encodeMemo — byte-budget thresholds (§2)", () => {
  const FIXED_TS = "2026-05-02T17:00:00.000Z";

  it("warns once when an envelope exceeds the soft warn threshold but stays under the hard limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // eval_score gives us a `notes` knob (max 280 chars) plus generous
    // subject/evaluator caps. Pick padding sizes that land between
    // MEMO_SOFT_WARN_BYTES (400) and MEMO_HARD_LIMIT_BYTES (566).
    const payload = {
      subject: "did:eto:agent:" + "a".repeat(60),
      metric: "helpfulness",
      score: 0.5,
      evaluator: "did:eto:eval:" + "b".repeat(60),
      notes: "n".repeat(120),
    };
    const raw = encodeMemo("eval_score", payload, { ts: FIXED_TS });
    const bytes = byteLengthUtf8(raw);

    expect(bytes).toBeGreaterThan(MEMO_SOFT_WARN_BYTES);
    expect(bytes).toBeLessThanOrEqual(MEMO_HARD_LIMIT_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects an envelope whose UTF-8 byte length exceeds the hard limit, citing the actual byte count", () => {
    // coordination_log doesn't have a single free-text overflow knob, so we
    // pad multiple max-length string fields to push the envelope past
    // MEMO_HARD_LIMIT_BYTES. parent_event accepts up to 128 chars; combined
    // with maxed task_id/actor/peer we comfortably blow the 566-byte budget.
    const oversize = {
      event: "task_offered",
      task_id: "T".repeat(128),
      actor: "A".repeat(128),
      peer: "P".repeat(128),
      parent_event: "E".repeat(128),
    };

    let thrown: Error | undefined;
    try {
      encodeMemo("coordination_log", oversize, { ts: FIXED_TS });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "encodeMemo must throw on oversize payloads").toBeDefined();
    expect(thrown!.message).toMatch(/exceeds hard/);
    // Hard-limit error message must include the actual byte count so producers
    // can see the gap they need to close.
    expect(thrown!.message).toMatch(/\b\d{3,}\b/);
  });

  it("accepts an envelope whose UTF-8 byte length is exactly MEMO_HARD_LIMIT_BYTES (boundary is inclusive)", () => {
    // Build a deterministic envelope that lands on EXACTLY 566 bytes by
    // sizing the eval_score `notes` field to absorb the residual bytes.
    // Mirrors how encodeMemo serialises (JSON.stringify on the same key
    // order: type, schema, v, ts, payload).
    // Pad subject + evaluator to consume bulk bytes so the residual fits
    // inside notes (max 280 chars).
    const subject = "did:eto:agent:" + "s".repeat(100);
    const evaluator = "did:eto:eval:" + "v".repeat(100);
    const buildPayload = (notes: string) => ({
      subject,
      metric: "m",
      score: 0.5,
      evaluator,
      notes,
    });
    const buildJson = (notes: string) =>
      JSON.stringify({
        type: "eval_score",
        schema: "eto.memo.eval_score.v1",
        v: 1,
        ts: FIXED_TS,
        payload: buildPayload(notes),
      });

    const baseLen = byteLengthUtf8(buildJson(""));
    const padLen = MEMO_HARD_LIMIT_BYTES - baseLen;
    expect(padLen).toBeGreaterThan(0);
    expect(padLen).toBeLessThanOrEqual(280); // notes maxLength per schema
    const notes = "x".repeat(padLen);

    // Sanity-check our offline computation matches what encodeMemo will emit.
    expect(byteLengthUtf8(buildJson(notes))).toBe(MEMO_HARD_LIMIT_BYTES);

    // Silence the soft-warn that fires above 400 bytes so the assertion log
    // stays clean.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const raw = encodeMemo("eval_score", buildPayload(notes), { ts: FIXED_TS });
    expect(byteLengthUtf8(raw)).toBe(MEMO_HARD_LIMIT_BYTES);
    // Round-trips successfully.
    const decoded = decodeMemo(raw);
    expect(decoded.ok).toBe(true);
  });
});
