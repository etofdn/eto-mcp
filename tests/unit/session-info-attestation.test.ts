import { describe, it, expect, beforeEach } from "vitest";
import { mintSessionAttestation } from "../../src/gateway/session-attestation.js";
import { __resetForTests } from "../../src/signing/server-key.js";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// FN-050: unit tests for the session_info model_attestation_jws field.
//
// Tests verify that mintSessionAttestation correctly embeds declared model
// fields (model_id, provider) into the JWS payload, and that the JWS shape
// is correct when model fields are absent (null case).

function decodePayload(jws: string): Record<string, unknown> {
  const [, payloadB64] = jws.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

const BASE_INPUT = {
  sub: "user-siwe",
  jti: "jti-test-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  __resetForTests();
});

describe("FN-050: model_attestation_jws surface in session_info", () => {
  it("JWS payload includes model_id and provider when declared_model is supplied", () => {
    const jws = mintSessionAttestation({
      ...BASE_INPUT,
      model_id_declared: "claude-sonnet-4-5",
      provider_declared: "anthropic",
    });
    const payload = decodePayload(jws);
    expect(payload["model_id"]).toBe("claude-sonnet-4-5");
    expect(payload["provider"]).toBe("anthropic");
    expect(payload["sub"]).toBe("user-siwe");
  });

  it("JWS payload omits model_id and provider when declared_model is absent", () => {
    const jws = mintSessionAttestation(BASE_INPUT);
    const payload = decodePayload(jws);
    expect(payload["model_id"]).toBeUndefined();
    expect(payload["provider"]).toBeUndefined();
    // Core fields still present
    expect(payload["sub"]).toBe("user-siwe");
    expect(payload["iss"]).toBe("eto-mcp");
  });

  it("JWS has three dot-separated parts (compact-JWS format)", () => {
    const jws = mintSessionAttestation(BASE_INPUT);
    expect(jws.split(".").length).toBe(3);
  });

  it("JWS header carries alg: EdDSA", () => {
    const jws = mintSessionAttestation(BASE_INPUT);
    const [headerB64] = jws.split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    expect(header["alg"]).toBe("EdDSA");
  });
});
