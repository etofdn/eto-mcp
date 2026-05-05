// FN-048 — HTTP integration test for GET /.well-known/jwks.json.
//
// We mount the route handler on a throwaway `express()` instance and bind to
// an ephemeral port (port 0 — kernel-assigned) rather than introducing a new
// HTTP-test dependency. This keeps the test surface aligned with what the
// SSE server wires up in `src/sse-server.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { resolve } from "path";
import {
  getCurrentJwks,
  __resetForTests as resetJwks,
} from "../../src/signing/jwks.js";
import {
  getServerPublicKeyBytes,
  __resetForTests as resetKey,
} from "../../src/signing/server-key.js";

const FIXTURE_PATH = resolve(__dirname, "../fixtures/server-signing-key.hex");

function b64urlDecode(s: string): Uint8Array {
  const pad = "===".slice((s.length + 3) % 4);
  return new Uint8Array(
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"),
  );
}

function buildApp(): Express {
  const app = express();
  app.get("/.well-known/jwks.json", (_req, res) => {
    try {
      const jwks = getCurrentJwks();
      res.set("Content-Type", "application/jwk-set+json");
      res.set("Cache-Control", "public, max-age=300, must-revalidate");
      res.status(200).json(jwks);
    } catch {
      res.status(500).json({ code: "JWKS_001", message: "JWKS unavailable" });
    }
  });
  return app;
}

describe("GET /.well-known/jwks.json (FN-048)", () => {
  let server: Server;
  let baseUrl: string;
  const originalKeyPath = process.env.MCP_SERVER_SIGNING_KEY_PATH;

  beforeAll(async () => {
    process.env.MCP_SERVER_SIGNING_KEY_PATH = FIXTURE_PATH;
    resetKey();
    resetJwks();
    const app = buildApp();
    server = await new Promise<Server>((res) => {
      const s = app.listen(0, "127.0.0.1", () => res(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    if (originalKeyPath === undefined) delete process.env.MCP_SERVER_SIGNING_KEY_PATH;
    else process.env.MCP_SERVER_SIGNING_KEY_PATH = originalKeyPath;
    resetKey();
    resetJwks();
  });

  beforeEach(() => {
    resetJwks();
  });

  it("returns 200 with application/jwk-set+json content type", async () => {
    const r = await fetch(`${baseUrl}/.well-known/jwks.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/jwk-set\+json/);
  });

  it("sets a public Cache-Control header matching the default overlap window", async () => {
    const r = await fetch(`${baseUrl}/.well-known/jwks.json`);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  it("body parses as JWKS and the single key matches getServerPublicKeyBytes()", async () => {
    const r = await fetch(`${baseUrl}/.well-known/jwks.json`);
    const body = (await r.json()) as { keys: Array<Record<string, string>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBe(1);
    const k = body.keys[0]!;
    expect(k.kty).toBe("OKP");
    expect(k.crv).toBe("Ed25519");
    expect(k.alg).toBe("EdDSA");
    expect(k.use).toBe("sig");
    expect(typeof k.kid).toBe("string");
    expect(k.kid.startsWith("mcp-server-")).toBe(true);
    expect(Buffer.from(b64urlDecode(k.x!))).toEqual(
      Buffer.from(getServerPublicKeyBytes()),
    );
  });

  it("works without authentication (no Bearer token)", async () => {
    // No Authorization header — must still return 200.
    const r = await fetch(`${baseUrl}/.well-known/jwks.json`, {
      headers: {}, // explicitly empty
    });
    expect(r.status).toBe(200);
  });
});
