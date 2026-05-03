import { describe, it, expect, vi, afterEach } from "vitest";
import {
  encodeMemo,
  decodeMemo,
  MEMO_HARD_LIMIT_BYTES,
  MEMO_SOFT_WARN_BYTES,
  byteLengthUtf8,
  type DecodeResult,
} from "../../src/memo/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encodeMemo / decodeMemo round-trip", () => {
  it("round-trips an eval_score envelope", () => {
    const raw = encodeMemo("eval_score", {
      subject: "did:eto:agent:abc",
      metric: "helpfulness",
      score: 0.87,
      evaluator: "did:eto:judge:llm-1",
    });
    const decoded = decodeMemo(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.type).toBe("eval_score");
    expect(decoded.envelope.schema).toBe("eto.memo.eval_score.v1");
    expect(decoded.envelope.v).toBe(1);
    expect(decoded.envelope.payload).toMatchObject({ score: 0.87 });
  });

  it("round-trips a payment envelope", () => {
    const raw = encodeMemo("payment", {
      purpose: "service",
      invoice_id: "inv-001",
    });
    const decoded = decodeMemo(raw);
    expect(decoded.ok).toBe(true);
  });

  it("round-trips a coordination_log envelope", () => {
    const raw = encodeMemo("coordination_log", {
      event: "task_offered",
      task_id: "t-1",
      actor: "did:eto:agent:a",
    });
    const decoded = decodeMemo(raw);
    expect(decoded.ok).toBe(true);
  });
});

describe("encodeMemo failures", () => {
  it("throws when the schema is unknown", () => {
    expect(() =>
      encodeMemo("not_a_real_type", { hi: "there" }),
    ).toThrow(/unknown schema/);
  });

  it("throws when the payload is invalid", () => {
    expect(() =>
      // missing required fields
      encodeMemo("payment", { purpose: "service" } as any),
    ).toThrow(/payload invalid/);
  });

  it("throws when type does not match the schema label", () => {
    expect(() =>
      encodeMemo("eval_score", { subject: "x", metric: "m", score: 0.1, evaluator: "e" }, {
        schema: "eto.memo.payment.v1",
      }),
    ).toThrow(/does not match/);
  });

  it("throws when v does not match the schema label suffix", () => {
    expect(() =>
      encodeMemo(
        "eval_score",
        { subject: "x", metric: "m", score: 0.1, evaluator: "e" },
        { v: 2 },
      ),
    ).toThrow(/unknown schema/);
  });

  it("rejects an oversize envelope", () => {
    // 280 chars of notes max → use evidence_uri padding via valid URI prefix
    const big = "x".repeat(280);
    expect(() =>
      encodeMemo("eval_score", {
        subject: "did:eto:agent:" + "a".repeat(100),
        metric: "m".repeat(60),
        score: 0.5,
        evaluator: "did:eto:eval:" + "b".repeat(100),
        notes: big,
      }),
    ).toThrow(/exceeds hard/);
  });

  it("warns when above soft limit but under hard limit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Build something between 400-566 bytes. Fixed ts so total size is
    // deterministic.
    const fixedTs = "2026-05-02T17:00:00.000Z";
    const notes = "n".repeat(180);
    const out = encodeMemo(
      "eval_score",
      {
        subject: "did:eto:agent:" + "a".repeat(50),
        metric: "helpfulness",
        score: 0.5,
        evaluator: "did:eto:eval:" + "b".repeat(50),
        notes,
      },
      { ts: fixedTs },
    );
    const bytes = byteLengthUtf8(out);
    expect(bytes).toBeGreaterThan(MEMO_SOFT_WARN_BYTES);
    expect(bytes).toBeLessThanOrEqual(MEMO_HARD_LIMIT_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/soft 400-byte budget/);
  });
});

describe("decodeMemo failure modes", () => {
  it("returns not_json for malformed input", () => {
    const r = decodeMemo("{not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_json");
    expect(r.raw).toBe("{not json");
  });

  it("returns envelope_invalid when a required field is missing", () => {
    const r = decodeMemo(JSON.stringify({ type: "x", schema: "eto.memo.x.v1", v: 1, ts: "2026-01-01T00:00:00Z" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("envelope_invalid");
  });

  it("returns envelope_invalid for additionalProperties", () => {
    const env = {
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: "2026-01-01T00:00:00Z",
      payload: { purpose: "service", invoice_id: "i1" },
      extra: "nope",
    };
    const r = decodeMemo(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("envelope_invalid");
  });

  it("returns type_schema_mismatch when type contradicts schema", () => {
    const env = {
      type: "payment",
      schema: "eto.memo.eval_score.v1",
      v: 1,
      ts: "2026-01-01T00:00:00Z",
      payload: {},
    };
    const r = decodeMemo(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("type_schema_mismatch");
  });

  it("returns unknown_schema for entirely unregistered types", () => {
    const env = {
      type: "ghost",
      schema: "eto.memo.ghost.v1",
      v: 1,
      ts: "2026-01-01T00:00:00Z",
      payload: { hi: 1 },
    };
    const r = decodeMemo(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_schema");
  });

  it("returns unknown_future_version for a known type at a higher v", () => {
    const env = {
      type: "payment",
      schema: "eto.memo.payment.v9",
      v: 9,
      ts: "2026-01-01T00:00:00Z",
      payload: { whatever: true },
    };
    const r = decodeMemo(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_future_version");
  });

  it("returns payload_invalid when payload fails its schema", () => {
    const env = {
      type: "payment",
      schema: "eto.memo.payment.v1",
      v: 1,
      ts: "2026-01-01T00:00:00Z",
      payload: { purpose: "not-an-enum-value", invoice_id: "i1" },
    };
    const r = decodeMemo(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("payload_invalid");
  });

  it("never throws — even on truly weird inputs", () => {
    const inputs = ["", "null", "false", "123", "[]", "{}", '"a string"'];
    for (const raw of inputs) {
      const r: DecodeResult = decodeMemo(raw);
      expect(r.ok).toBe(false);
    }
  });
});
