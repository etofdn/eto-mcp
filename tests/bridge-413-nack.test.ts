/**
 * FN-092 — Beckn bridge 413 NACK shape
 *
 * Locks the behaviour added by `becknPayloadTooLargeMiddleware` in
 * `src/gateway/beckn.ts`: when a request body exceeds the 1 MiB per-route
 * `express.json` limit, the bridge returns 413 with the canonical Beckn
 * NACK envelope `{message:{ack:{status:"NACK"}}, error:{code, message}}`,
 * not Express's default HTML/text 413 body.
 *
 * Three cases:
 *  1. POST /search with > 1 MiB body → 413 + NACK shape, code=PAYLOAD_TOO_LARGE
 *  2. POST /search with small but envelope-invalid body → 400 + BECKN_400
 *     (regression: middleware does NOT swallow ordinary errors)
 *  3. POST /select with > 1 MiB body → 413 + NACK shape (middleware is global,
 *     not per-route)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createBecknApp } from "../src/gateway/beckn.js";

type BootedServer = { server: http.Server; baseUrl: string };

async function bootApp(): Promise<BootedServer> {
  return new Promise((resolve) => {
    const app = createBecknApp();
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function freshContext(action: "search" | "select" | "init" | "confirm") {
  return {
    domain: "nic2004:52110",
    action,
    version: "2.0.0",
    bap_id: "test-bap.example.com",
    bap_uri: "https://test-bap.example.com",
    transaction_id: "11111111-1111-1111-1111-111111111111",
    message_id: "22222222-2222-2222-2222-222222222222",
    timestamp: new Date().toISOString(),
  };
}

describe("FN-092 — Beckn bridge 413 NACK shape", () => {
  let srv: BootedServer;

  beforeAll(async () => {
    srv = await bootApp();
  });

  afterAll(async () => {
    await closeServer(srv.server);
  });

  it("POST /search with body > 1 MiB → 413 + Beckn NACK envelope", async () => {
    const padding = "x".repeat(1_200_000);
    const body = JSON.stringify({
      context: freshContext("search"),
      message: { big_field: padding },
    });
    const res = await fetch(`${srv.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      message: { ack: { status: string } };
      error: { code: string; message: string };
    };
    expect(json.message.ack.status).toBe("NACK");
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(typeof json.error.message).toBe("string");
    expect(json.error.message.length).toBeGreaterThan(0);
  });

  it("POST /search with small invalid body → 400 BECKN_400 (regression: middleware does not swallow ordinary errors)", async () => {
    const res = await fetch(`${srv.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Missing context entirely — fails becknRequestSchema, exercised by
      // makeHandler() which returns 400 + BECKN_400 directly (not via error
      // middleware). This proves the new 413 handler is scoped to oversized
      // bodies and not catching unrelated 4xx flows.
      body: JSON.stringify({ message: { intent: {} } }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      message: { ack: { status: string } };
      error: { code: string; message: string };
    };
    expect(json.message.ack.status).toBe("NACK");
    expect(json.error.code).toBe("BECKN_400");
  });

  it("POST /select with body > 1 MiB → 413 + Beckn NACK envelope (middleware is global, not per-route)", async () => {
    const padding = "x".repeat(1_200_000);
    const body = JSON.stringify({
      context: freshContext("select"),
      message: { big_field: padding },
    });
    const res = await fetch(`${srv.baseUrl}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      message: { ack: { status: string } };
      error: { code: string; message: string };
    };
    expect(json.message.ack.status).toBe("NACK");
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
