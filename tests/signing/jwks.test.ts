import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { resolve } from "path";
import {
  computeKid,
  buildJwk,
  getCurrentJwks,
  rotateServerKey,
  __resetForTests as resetJwks,
} from "../../src/signing/jwks.js";
import {
  getServerPublicKeyBytes,
  __resetForTests as resetKey,
} from "../../src/signing/server-key.js";

const FIXTURE_PATH = resolve(__dirname, "../fixtures/server-signing-key.hex");

function snapshotEnv(): () => void {
  const prev = {
    path: process.env.MCP_SERVER_SIGNING_KEY_PATH,
    overlap: process.env.MCP_JWKS_OVERLAP_SECONDS,
    nodeEnv: process.env.NODE_ENV,
  };
  return () => {
    for (const [k, v] of Object.entries({
      MCP_SERVER_SIGNING_KEY_PATH: prev.path,
      MCP_JWKS_OVERLAP_SECONDS: prev.overlap,
      NODE_ENV: prev.nodeEnv,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "===".slice((s.length + 3) % 4);
  return new Uint8Array(
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"),
  );
}

describe("jwks (FN-048)", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    process.env.MCP_SERVER_SIGNING_KEY_PATH = FIXTURE_PATH;
    resetJwks();
    resetKey();
  });
  afterEach(() => {
    restoreEnv();
    resetJwks();
    resetKey();
    vi.restoreAllMocks();
  });

  describe("computeKid", () => {
    it("is deterministic for the same inputs", () => {
      expect(computeKid("2025-01-01T00:00:00.000Z", 0))
        .toBe(computeKid("2025-01-01T00:00:00.000Z", 0));
    });
    it("changes when serverInstance changes", () => {
      expect(computeKid("a", 0)).not.toBe(computeKid("b", 0));
    });
    it("changes when rotationEpoch changes", () => {
      expect(computeKid("a", 0)).not.toBe(computeKid("a", 1));
    });
    it("starts with the mcp-server- prefix and is 16 chars after the prefix", () => {
      const kid = computeKid("instance", 7);
      expect(kid.startsWith("mcp-server-")).toBe(true);
      expect(kid.length).toBe("mcp-server-".length + 16);
    });
  });

  describe("buildJwk", () => {
    it("produces RFC 7517 / RFC 8037 OKP+Ed25519 shape", () => {
      const pub = getServerPublicKeyBytes();
      const jwk = buildJwk(pub, "kid-x");
      expect(jwk.kty).toBe("OKP");
      expect(jwk.crv).toBe("Ed25519");
      expect(jwk.alg).toBe("EdDSA");
      expect(jwk.use).toBe("sig");
      expect(jwk.kid).toBe("kid-x");
      // base64url, no padding.
      expect(jwk.x).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(jwk.x.endsWith("=")).toBe(false);
    });
    it("x round-trips to the original public-key bytes", () => {
      const pub = getServerPublicKeyBytes();
      const jwk = buildJwk(pub, "kid-x");
      expect(Buffer.from(b64urlDecode(jwk.x))).toEqual(Buffer.from(pub));
    });
  });

  describe("getCurrentJwks", () => {
    it("serves exactly one key when no rotation has occurred", () => {
      const jwks = getCurrentJwks();
      expect(jwks.keys.length).toBe(1);
    });

    it("serves both current and previous after rotation, with distinct kids", () => {
      const before = getCurrentJwks().keys[0]!;
      const newKey = ed.utils.randomPrivateKey();
      rotateServerKey(newKey, { overlapSeconds: 300, nowMs: 1_000_000 });
      const after = getCurrentJwks(new Date(1_000_000));
      expect(after.keys.length).toBe(2);
      const kids = after.keys.map(k => k.kid);
      expect(new Set(kids).size).toBe(2);
      // The previous key from before the rotation must still appear.
      expect(kids).toContain(before.kid);
    });

    it("drops the overlap key after rotatedAt + overlapSeconds elapses", () => {
      const newKey = ed.utils.randomPrivateKey();
      rotateServerKey(newKey, { overlapSeconds: 60, nowMs: 1_000_000 });
      // Just after rotation: 2 keys.
      expect(getCurrentJwks(new Date(1_000_000)).keys.length).toBe(2);
      // Within window: still 2.
      expect(getCurrentJwks(new Date(1_000_000 + 60_000)).keys.length).toBe(2);
      // Past window: only the new key remains.
      const after = getCurrentJwks(new Date(1_000_000 + 60_001));
      expect(after.keys.length).toBe(1);
      // Surviving key matches the new public key bytes.
      const expectedPub = ed.getPublicKey(newKey);
      const survivingX = after.keys[0]!.x;
      expect(Buffer.from(b64urlDecode(survivingX))).toEqual(Buffer.from(expectedPub));
    });
  });

  describe("rotateServerKey overlap-window validation", () => {
    it("rejects overlapSeconds < 60", () => {
      expect(() =>
        rotateServerKey(ed.utils.randomPrivateKey(), { overlapSeconds: 30 }),
      ).toThrow(/\[60, 86400\]/);
    });
    it("rejects overlapSeconds > 86400", () => {
      expect(() =>
        rotateServerKey(ed.utils.randomPrivateKey(), { overlapSeconds: 86401 }),
      ).toThrow(/\[60, 86400\]/);
    });
    it("rejects non-32-byte seed", () => {
      expect(() => rotateServerKey(new Uint8Array(31))).toThrow(/32-byte/);
    });
  });
});
