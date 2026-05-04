/**
 * Tests for inbound-bap.ts — FN-088 / T-2.8.2.1
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "http";
import {
  mountInboundBap,
  becknSearchToOnChainArgs,
  canonicalJson,
  extractTags,
  sha256_hex,
  stubSubmit,
  validateBecknEnvelope,
  validateBecknEnvelopeFreshness,
  type InboundBapDeps,
  type NackBody,
} from "./inbound-bap.js";

// ---------- Minimal HTTP test helper ----------

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

// ---------- Fixtures ----------

const validSearchBody = {
  context: {
    domain: "nic2004:52110",
    action: "search",
    version: "2.0.0",
    bap_id: "test-bap.example.com",
    bap_uri: "https://test-bap.example.com",
    transaction_id: "11111111-1111-1111-1111-111111111111",
    message_id: "22222222-2222-2222-2222-222222222222",
    timestamp: "2024-01-01T00:00:00.000Z",
  },
  message: {
    intent: {
      category: { descriptor: { code: "groceries" } },
      // Beckn v2.0 tags are objects, not strings
      tags: [
        { descriptor: { code: "fresh" } },
        { descriptor: { code: "organic" } },
      ],
    },
  },
};

const validSelectBody = {
  context: {
    domain: "nic2004:52110",
    action: "select",
    version: "2.0.0",
    bap_id: "test-bap.example.com",
    bap_uri: "https://test-bap.example.com",
    transaction_id: "33333333-3333-3333-3333-333333333333",
    message_id: "44444444-4444-4444-4444-444444444444",
    timestamp: "2024-01-01T00:00:00.000Z",
    bpp_id: "test-bpp.example.com",
    bpp_uri: "https://test-bpp.example.com",
  },
  message: {
    order: {
      provider: { id: "provider-pda-abc123" },
      items: [{ id: "item-1" }],
    },
  },
};

// ---------- HTTP integration tests ----------

describe("mountInboundBap — /search endpoint", () => {
  let server: http.Server;
  let submitMock: ReturnType<typeof vi.fn>;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        const app = express();
        app.use(express.json());
        submitMock = vi.fn().mockResolvedValue({ tx_signature: "aaaa".repeat(16) });
        const deps: InboundBapDeps = { submitOnChain: submitMock };
        mountInboundBap(app, deps);
        server = app.listen(0, "127.0.0.1", resolve);
      }),
  );

  it("returns 202 ACK + tx_signature for a valid /search", async () => {
    const { status, body } = await jsonPost(server, "/search", validSearchBody);
    expect(status).toBe(202);
    const b = body as Record<string, unknown>;
    expect((b.message as Record<string, unknown>)?.ack).toEqual({ status: "ACK" });
    expect(typeof b.tx_signature).toBe("string");
    expect((b.tx_signature as string).length).toBeGreaterThan(0);
    server.close();
  });

  it("calls submitOnChain with action=search and intent_hash", async () => {
    await jsonPost(server, "/search", validSearchBody);
    expect(submitMock).toHaveBeenCalledOnce();
    const [action, args] = submitMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(action).toBe("search");
    expect(typeof args.intent_hash).toBe("string");
    expect((args.intent_hash as string).length).toBe(64);
    server.close();
  });

  it("returns 400 with details when context.bap_id is missing", async () => {
    const bad = {
      ...validSearchBody,
      context: { ...validSearchBody.context, bap_id: undefined },
    };
    const { status, body } = await jsonPost(server, "/search", bad);
    expect(status).toBe(400);
    const b = body as Record<string, unknown>;
    expect(b.error).toBe("beckn_validation_failed");
    expect(Array.isArray(b.details)).toBe(true);
    expect((b.details as unknown[]).length).toBeGreaterThan(0);
    server.close();
  });

  it("returns 202 ACK + tx_signature for a valid /select", async () => {
    const { status, body } = await jsonPost(server, "/select", validSelectBody);
    expect(status).toBe(202);
    const b = body as Record<string, unknown>;
    expect((b.message as Record<string, unknown>)?.ack).toEqual({ status: "ACK" });
    expect(typeof b.tx_signature).toBe("string");
    server.close();
  });
});

// ---------- Unit tests for pure helpers ----------

describe("becknSearchToOnChainArgs", () => {
  it("produces a deterministic intent_hash for identical input", () => {
    const result1 = becknSearchToOnChainArgs(validSearchBody);
    const result2 = becknSearchToOnChainArgs(validSearchBody);
    expect(result1.intent_hash).toBe(result2.intent_hash);
    expect(typeof result1.intent_hash).toBe("string");
    expect((result1.intent_hash as string).length).toBe(64);
  });

  it("produces different intent_hash for different intents", () => {
    const other = {
      ...validSearchBody,
      message: { intent: { category: { descriptor: { code: "electronics" } } } },
    };
    const r1 = becknSearchToOnChainArgs(validSearchBody);
    const r2 = becknSearchToOnChainArgs(other);
    expect(r1.intent_hash).not.toBe(r2.intent_hash);
  });

  it("derives network_id from domain", () => {
    const r = becknSearchToOnChainArgs(validSearchBody);
    expect(r.network_id).toBe(sha256_hex(validSearchBody.context.domain));
  });
});

describe("canonicalJson", () => {
  it("orders keys alphabetically for stable hashing", () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with consistent ordering", () => {
    const obj = { b: { y: 1, x: 2 }, a: 3 };
    expect(canonicalJson(obj)).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });

  it("handles arrays without reordering elements", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
  });
});

describe("extractTags", () => {
  it("extracts category.descriptor.code", () => {
    const intent = { category: { descriptor: { code: "groceries" } } };
    expect(extractTags(intent)).toContain("groceries");
  });

  it("extracts string items from root tags array", () => {
    const intent = { tags: ["fresh", "organic", 123] };
    const result = extractTags(intent);
    expect(result).toContain("fresh");
    expect(result).toContain("organic");
    // non-string entries are excluded
    expect(result).not.toContain(123);
  });

  it("extracts Beckn v2.0 Tag object codes from root tags array", () => {
    const intent = {
      tags: [
        { descriptor: { code: "fresh" } },
        { descriptor: { code: "organic" } },
      ],
    };
    const result = extractTags(intent);
    expect(result).toContain("fresh");
    expect(result).toContain("organic");
  });

  it("extracts both category.descriptor.code AND root tags array together", () => {
    const intent = {
      category: { descriptor: { code: "groceries" } },
      tags: [
        { descriptor: { code: "fresh" } },
        { descriptor: { code: "organic" } },
      ],
    };
    const result = extractTags(intent);
    expect(result).toEqual(["groceries", "fresh", "organic"]);
  });

  it("returns empty array for null/undefined intent", () => {
    expect(extractTags(null)).toEqual([]);
    expect(extractTags(undefined)).toEqual([]);
  });
});

describe("stubSubmit", () => {
  it("returns a hex tx_signature of length 64", async () => {
    const result = await stubSubmit("search", { foo: "bar" });
    expect(result.tx_signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns deterministic tx_signature for same input", async () => {
    const r1 = await stubSubmit("search", { foo: "bar" });
    const r2 = await stubSubmit("search", { foo: "bar" });
    expect(r1.tx_signature).toBe(r2.tx_signature);
  });
});

// ---------- Envelope hardening parity tests (FN-074 / FN-188) ----------

describe("validateBecknEnvelope + freshness (four defect cases)", () => {
  const base = { ...validSearchBody };

  it("rejects BAD_VERSION", async () => {
    const bad = { ...base, context: { ...base.context, version: "1.0.0" } };
    const env = validateBecknEnvelope(bad.context);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.body.error.code).toBe("BAD_VERSION");
      expect(env.status).toBe(400);
    }
  });

  it("rejects BAD_TIMESTAMP (malformed)", async () => {
    const bad = { ...base, context: { ...base.context, timestamp: "2024-13-01T00:00:00Z" } };
    const env = validateBecknEnvelope(bad.context);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.body.error.code).toBe("BAD_TIMESTAMP");
      expect(env.status).toBe(400);
    }
  });

  it("rejects BAD_TTL (malformed)", async () => {
    const bad = { ...base, context: { ...base.context, ttl: "30 seconds" } };
    const env = validateBecknEnvelope(bad.context);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.body.error.code).toBe("BAD_TTL");
      expect(env.status).toBe(400);
    }
  });

  it("rejects EXPIRED_TTL (timestamp + ttl < now)", async () => {
    const past = new Date(Date.now() - 1000 * 3600 * 24 * 7).toISOString();
    const bad = { ...base, context: { ...base.context, timestamp: past, ttl: "PT1S" } };
    const env = validateBecknEnvelope(bad.context);
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.body.error.code).toBe("EXPIRED_TTL");
      expect(env.status).toBe(400);
    }
  });

  it("POST /search with bad version returns 400 NACK", async () => {
    // self-contained server for this edge case test to avoid scope/close races
    const app = express();
    app.use(express.json());
    const mock = vi.fn().mockResolvedValue({ tx_signature: "dead".repeat(16) });
    mountInboundBap(app, { submitOnChain: mock });
    const localServer = app.listen(0, "127.0.0.1");
    const addr = localServer.address() as { port: number };
    try {
      const bad = { ...base, context: { ...base.context, version: "1.0.0" } };
      const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const data = JSON.stringify(bad);
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: "/search",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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
      expect(status).toBe(400);
      const b = body as Record<string, unknown>;
      expect((b.error as Record<string, unknown>)?.code).toBe("BAD_VERSION");
    } finally {
      localServer.close();
    }
  });
});
