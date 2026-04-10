import { describe, test, expect } from "bun:test";
import {
  createSession,
  verifySession,
  hasCapability,
  createDevSession,
  CAPABILITY_SCOPES,
  type Capability,
} from "../../src/gateway/session.js";
import { requireCapability } from "../../src/gateway/auth.js";
import { RateLimiter } from "../../src/gateway/rate-limiter.js";
import { McpError } from "../../src/errors/index.js";

const ALL_CAPS = Object.keys(CAPABILITY_SCOPES) as Capability[];

describe("createSession + verifySession round-trip", () => {
  test("verified session returns same payload fields", () => {
    const token = createSession({
      userId: "user-1",
      walletId: "wallet-abc",
      network: "testnet",
      capabilities: ["wallet:read", "token:read"],
      ttlSeconds: 300,
    });

    const payload = verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("user-1");
    expect(payload!.wallet_id).toBe("wallet-abc");
    expect(payload!.network).toBe("testnet");
    expect(payload!.caps).toEqual(["wallet:read", "token:read"]);
    expect(payload!.iss).toBe("eto-mcp");
    expect(payload!.aud).toBe("eto-agent");
  });

  test("verified session has valid exp and iat", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = createSession({
      userId: "u",
      walletId: "w",
      ttlSeconds: 60,
    });
    const after = Math.floor(Date.now() / 1000);
    const payload = verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
    expect(payload!.exp).toBeGreaterThanOrEqual(before + 60);
    expect(payload!.exp).toBeLessThanOrEqual(after + 60);
  });

  test("session has unique jti per call", () => {
    const t1 = createSession({ userId: "u", walletId: "w" });
    const t2 = createSession({ userId: "u", walletId: "w" });
    const p1 = verifySession(t1);
    const p2 = verifySession(t2);
    expect(p1!.jti).not.toBe(p2!.jti);
  });

  test("defaults network to testnet and caps to all when not specified", () => {
    const token = createSession({ userId: "u", walletId: "w" });
    const payload = verifySession(token);
    expect(payload!.network).toBe("testnet");
    expect(payload!.caps.length).toBeGreaterThan(0);
  });
});

describe("expired token rejection", () => {
  test("token with past expiry returns null", () => {
    // Create session, then manually craft an expired token
    // We can create session with ttlSeconds=-1 which gives exp < now
    const token = createSession({
      userId: "u",
      walletId: "w",
      ttlSeconds: -1,
    });
    const payload = verifySession(token);
    expect(payload).toBeNull();
  });

  test("token with very short ttl expires quickly", async () => {
    // Use negative ttl to simulate already-expired token
    const token = createSession({
      userId: "u",
      walletId: "w",
      ttlSeconds: -100,
    });
    expect(verifySession(token)).toBeNull();
  });
});

describe("tampered signature rejection", () => {
  test("modifying signature portion causes rejection", () => {
    const token = createSession({ userId: "u", walletId: "w" });
    const [payloadB64, sig] = token.split(".");
    // Flip a character in the signature
    const tamperedSig = sig.slice(0, -4) + "XXXX";
    const tamperedToken = `${payloadB64}.${tamperedSig}`;
    expect(verifySession(tamperedToken)).toBeNull();
  });

  test("modifying payload portion causes rejection", () => {
    const token = createSession({ userId: "u", walletId: "w" });
    const [payloadB64, sig] = token.split(".");
    // Decode, mutate the JSON, re-encode — this changes the payload without touching the sig
    const json = Buffer.from(payloadB64, "base64url").toString();
    const payload = JSON.parse(json);
    payload.sub = "attacker";
    const alteredB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tamperedToken = `${alteredB64}.${sig}`;
    expect(verifySession(tamperedToken)).toBeNull();
  });

  test("completely invalid token returns null", () => {
    expect(verifySession("not.a.valid.token")).toBeNull();
    expect(verifySession("")).toBeNull();
    expect(verifySession("justonepart")).toBeNull();
  });
});

describe("dev bypass session", () => {
  test("createDevSession returns valid token", () => {
    const token = createDevSession("dev-wallet-123");
    expect(typeof token).toBe("string");
    const payload = verifySession(token);
    expect(payload).not.toBeNull();
  });

  test("dev session has all capabilities", () => {
    const token = createDevSession("dev-wallet-123");
    const payload = verifySession(token);
    expect(payload).not.toBeNull();
    for (const cap of ALL_CAPS) {
      expect(payload!.caps).toContain(cap);
    }
  });

  test("dev session wallet_id matches argument", () => {
    const token = createDevSession("my-dev-wallet");
    const payload = verifySession(token);
    expect(payload!.wallet_id).toBe("my-dev-wallet");
  });

  test("dev session has 24h ttl", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = createDevSession("w");
    const payload = verifySession(token);
    // Should expire roughly 24h from now
    expect(payload!.exp).toBeGreaterThanOrEqual(before + 86400 - 5);
  });
});

describe("hasCapability", () => {
  test("returns true when session has the capability", () => {
    const token = createSession({
      userId: "u",
      walletId: "w",
      capabilities: ["wallet:read", "token:read"],
    });
    const payload = verifySession(token)!;
    expect(hasCapability(payload, "wallet:read")).toBe(true);
    expect(hasCapability(payload, "token:read")).toBe(true);
  });

  test("returns false when session lacks the capability", () => {
    const token = createSession({
      userId: "u",
      walletId: "w",
      capabilities: ["wallet:read"],
    });
    const payload = verifySession(token)!;
    expect(hasCapability(payload, "transfer:write")).toBe(false);
    expect(hasCapability(payload, "deploy:write")).toBe(false);
  });
});

describe("requireCapability", () => {
  test("does not throw when session has the required capability", () => {
    const token = createSession({
      userId: "u",
      walletId: "w",
      capabilities: ["wallet:read", "transfer:write"],
    });
    const payload = verifySession(token)!;
    expect(() => requireCapability(payload, "wallet:read")).not.toThrow();
    expect(() => requireCapability(payload, "transfer:write")).not.toThrow();
  });

  test("throws McpError with AUTH_002 when capability is missing", () => {
    const token = createSession({
      userId: "u",
      walletId: "w",
      capabilities: ["wallet:read"],
    });
    const payload = verifySession(token)!;
    expect(() => requireCapability(payload, "deploy:write")).toThrow(McpError);
    try {
      requireCapability(payload, "deploy:write");
    } catch (e) {
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).code).toBe("AUTH_002");
      expect((e as McpError).category).toBe("auth");
    }
  });

  test("throws for multiple missing caps", () => {
    const token = createSession({
      userId: "u",
      walletId: "w",
      capabilities: ["chain:read"],
    });
    const payload = verifySession(token)!;
    expect(() => requireCapability(payload, "transfer:write")).toThrow();
    expect(() => requireCapability(payload, "zk:write")).toThrow();
  });
});

describe("RateLimiter", () => {
  test("allows requests up to the limit", () => {
    const limiter = new RateLimiter();
    // readPerMinute is 100 from config - but config reads env
    // Use write category (20/min) for a smaller limit test
    // We set up a fresh limiter; bucket starts at maxTokens
    // We can exhaust tokens by calling check many times on unique key
    const key = "test-user-" + Math.random();
    // Each check() consumes 1 token. writePerMinute = 20
    // Just verify 5 calls succeed without throwing
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check(key, "write")).not.toThrow();
    }
  });

  test("throws McpError with RATE_001 when limit exceeded", () => {
    const limiter = new RateLimiter();
    const key = "exhaust-user-" + Math.random();
    // writePerMinute = 20 from config. Exhaust the bucket.
    let threw = false;
    try {
      for (let i = 0; i < 100; i++) {
        limiter.check(key, "write");
      }
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(McpError);
      expect((e as McpError).code).toBe("RATE_001");
      expect((e as McpError).category).toBe("policy");
      expect((e as McpError).retryable).toBe(true);
    }
    expect(threw).toBe(true);
  });

  test("different keys have independent buckets", () => {
    const limiter = new RateLimiter();
    const key1 = "key1-" + Math.random();
    const key2 = "key2-" + Math.random();
    // Exhaust key1
    let key1Threw = false;
    try {
      for (let i = 0; i < 100; i++) limiter.check(key1, "deploy");
    } catch {
      key1Threw = true;
    }
    expect(key1Threw).toBe(true);
    // key2 should still work
    expect(() => limiter.check(key2, "deploy")).not.toThrow();
  });

  test("deploy category has lower limit than read", () => {
    const limiter = new RateLimiter();
    const key = "deploy-limit-" + Math.random();
    let deployThrew = false;
    let deployCount = 0;
    try {
      for (let i = 0; i < 200; i++) {
        limiter.check(key, "deploy");
        deployCount++;
      }
    } catch {
      deployThrew = true;
    }

    const key2 = "read-limit-" + Math.random();
    let readThrew = false;
    let readCount = 0;
    try {
      for (let i = 0; i < 200; i++) {
        limiter.check(key2, "read");
        readCount++;
      }
    } catch {
      readThrew = true;
    }

    expect(deployThrew).toBe(true);
    expect(readThrew).toBe(true);
    // Read allows more than deploy
    expect(readCount).toBeGreaterThan(deployCount);
  });
});
