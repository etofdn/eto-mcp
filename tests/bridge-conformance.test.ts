/**
 * Beckn v2.0 Bridge Conformance Tests — FN-074
 *
 * Tests SB-17..SB-20: envelope-level validation enforced by the inbound BAP
 * bridge. Each test exercises the new `validateBecknEnvelope` pre-check that
 * runs before the full Ajv schema validator.
 *
 * Conformance IDs:
 *   SB-17 — version pinning: context.version !== "2.0.0" → 400 BAD_VERSION
 *   SB-18 — malformed timestamp            → 400 BAD_TIMESTAMP
 *   SB-19 — malformed TTL                  → 400 BAD_TTL
 *   SB-20 — expired TTL                    → 400 EXPIRED_TTL
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "http";
import {
  mountInboundBap,
  type InboundBapDeps,
} from "../src/gateway/inbound-bap.js";

// ---------- HTTP test helper ----------

function jsonPost(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------- Server factory ----------

function makeServer(): Promise<{ server: http.Server; submitMock: ReturnType<typeof vi.fn> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const submitMock = vi.fn().mockResolvedValue({ tx_signature: "ab".repeat(32) });
    const deps: InboundBapDeps = { submitOnChain: submitMock };
    mountInboundBap(app, deps);
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, submitMock }));
  });
}

// ---------- Fixtures ----------

/** A current, fully-valid /search body fixture. */
const validSearchBody = {
  context: {
    domain: "nic2004:52110",
    action: "search",
    version: "2.0.0",
    bap_id: "test-bap.example.com",
    bap_uri: "https://test-bap.example.com",
    transaction_id: "11111111-1111-1111-1111-111111111111",
    message_id: "22222222-2222-2222-2222-222222222222",
    timestamp: new Date().toISOString(), // current — will not be expired
  },
  message: {
    intent: {
      category: { descriptor: { code: "groceries" } },
    },
  },
};

// ---------- NACK shape matcher ----------

function expectNack(
  body: unknown,
  code: "BAD_VERSION" | "BAD_TIMESTAMP" | "BAD_TTL" | "EXPIRED_TTL",
) {
  const b = body as Record<string, unknown>;
  expect(b).toMatchObject({
    message: { ack: { status: "NACK" } },
    error: {
      code,
      message: expect.any(String),
    },
  });
}

// ---------- Conformance suite ----------

describe("Beckn v2.0 Envelope Conformance (SB-17..SB-20)", () => {
  let server: http.Server;

  afterEach(() => {
    server.close();
  });

  // ----------------------------------------------------------------
  // Happy-path baseline — ensure valid envelopes are still accepted
  // ----------------------------------------------------------------
  it("accepts a valid /search envelope with current timestamp and returns 202 ACK", async () => {
    ({ server } = await makeServer());
    const body = {
      ...validSearchBody,
      context: {
        ...validSearchBody.context,
        ttl: "PT30S", // valid ISO-8601 duration
        timestamp: new Date(Date.now() + 2000).toISOString(), // fresh safety margin for Wall time between creation & check
      },
    };
    const { status, body: resBody } = await jsonPost(server, "/search", body);
    expect(status).toBe(202);
    const b = resBody as Record<string, unknown>;
    expect((b.message as Record<string, unknown>)?.ack).toEqual({ status: "ACK" });
  });

  it("accepts a valid /search envelope without ttl and returns 202 ACK", async () => {
    ({ server } = await makeServer());
    const { status, body: resBody } = await jsonPost(server, "/search", validSearchBody);
    expect(status).toBe(202);
    const b = resBody as Record<string, unknown>;
    expect((b.message as Record<string, unknown>)?.ack).toEqual({ status: "ACK" });
  });

  // ----------------------------------------------------------------
  // SB-17 — version pinning
  // ----------------------------------------------------------------
  it("SB-17: rejects context.version !== \"2.0.0\" with 400 BAD_VERSION", async () => {
    ({ server } = await makeServer());
    const body = {
      ...validSearchBody,
      context: { ...validSearchBody.context, version: "1.1.0" },
    };
    const { status, body: resBody } = await jsonPost(server, "/search", body);
    expect(status).toBe(400);
    expectNack(resBody, "BAD_VERSION");
  });

  // ----------------------------------------------------------------
  // SB-18 — malformed timestamp
  // ----------------------------------------------------------------
  it("SB-18: rejects malformed context.timestamp with 400 BAD_TIMESTAMP", async () => {
    ({ server } = await makeServer());
    const body = {
      ...validSearchBody,
      context: { ...validSearchBody.context, timestamp: "yesterday" },
    };
    const { status, body: resBody } = await jsonPost(server, "/search", body);
    expect(status).toBe(400);
    expectNack(resBody, "BAD_TIMESTAMP");
  });

  // ----------------------------------------------------------------
  // SB-19 — malformed TTL
  // ----------------------------------------------------------------
  it("SB-19: rejects non-ISO-8601 context.ttl with 400 BAD_TTL", async () => {
    ({ server } = await makeServer());
    const body = {
      ...validSearchBody,
      context: {
        ...validSearchBody.context,
        timestamp: new Date().toISOString(),
        ttl: "30 seconds", // human-readable, not ISO-8601
      },
    };
    const { status, body: resBody } = await jsonPost(server, "/search", body);
    expect(status).toBe(400);
    expectNack(resBody, "BAD_TTL");
  });

  // ----------------------------------------------------------------
  // SB-20 — expired TTL
  // ----------------------------------------------------------------
  it("SB-20: rejects an envelope whose timestamp+ttl is in the past with 400 EXPIRED_TTL", async () => {
    ({ server } = await makeServer());
    const body = {
      ...validSearchBody,
      context: {
        ...validSearchBody.context,
        timestamp: "2000-01-01T00:00:00.000Z", // far in the past
        ttl: "PT30S", // 30 second window — long expired
      },
    };
    const { status, body: resBody } = await jsonPost(server, "/search", body);
    expect(status).toBe(400);
    expectNack(resBody, "EXPIRED_TTL");
  });
});

// ---------- Unit tests for pure helpers ----------

describe("parseIso8601DurationMs", () => {
  it("parses PT30S → 30_000 ms", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("PT30S")).toBe(30_000);
  });

  it("parses PT1H → 3_600_000 ms", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("PT1H")).toBe(3_600_000);
  });

  it("parses P1D → 86_400_000 ms", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("P1D")).toBe(86_400_000);
  });

  it("parses P1W → 604_800_000 ms", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("P1W")).toBe(604_800_000);
  });

  it("parses PT1.5S (fractional seconds) → 1500 ms", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("PT1.5S")).toBe(1500);
  });

  it("rejects year designator (P1Y) → null (calendar-relative)", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("P1Y")).toBeNull();
  });

  it("rejects month designator (P1M) → null (calendar-relative)", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("P1M")).toBeNull();
  });

  it("rejects freeform strings → null", async () => {
    const { parseIso8601DurationMs } = await import("../src/gateway/inbound-bap.js");
    expect(parseIso8601DurationMs("30 seconds")).toBeNull();
    expect(parseIso8601DurationMs("30s")).toBeNull();
    expect(parseIso8601DurationMs("")).toBeNull();
  });
});

describe("validateBecknEnvelope", () => {
  it("returns ok:true for a valid context with no ttl", async () => {
    const { validateBecknEnvelope } = await import("../src/gateway/inbound-bap.js");
    const ctx = {
      version: "2.0.0",
      timestamp: "2030-01-01T00:00:00.000Z",
    };
    expect(validateBecknEnvelope(ctx)).toEqual({ ok: true });
  });

  it("returns ok:true for a valid context with future ttl", async () => {
    const { validateBecknEnvelope } = await import("../src/gateway/inbound-bap.js");
    const ctx = {
      version: "2.0.0",
      timestamp: "2030-01-01T00:00:00.000Z",
      ttl: "PT30S",
    };
    const fakeNow = new Date("2029-12-31T00:00:00.000Z").getTime();
    expect(validateBecknEnvelope(ctx, fakeNow)).toEqual({ ok: true });
  });

  it("returns BAD_VERSION for wrong version", async () => {
    const { validateBecknEnvelope } = await import("../src/gateway/inbound-bap.js");
    const result = validateBecknEnvelope({ version: "1.0.0", timestamp: "2030-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error.code).toBe("BAD_VERSION");
  });

  it("returns EXPIRED_TTL when injected now is past expiry", async () => {
    const { validateBecknEnvelope } = await import("../src/gateway/inbound-bap.js");
    const ctx = {
      version: "2.0.0",
      timestamp: "2000-01-01T00:00:00.000Z",
      ttl: "PT30S",
    };
    const result = validateBecknEnvelope(ctx, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error.code).toBe("EXPIRED_TTL");
  });
});
