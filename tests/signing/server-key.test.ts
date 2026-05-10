import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { resolve } from "path";
import {
  getServerSigningKey,
  getServerPublicKeyBytes,
  getServerInstance,
  __resetForTests,
} from "../../src/signing/server-key.js";

const FIXTURE_PATH = resolve(__dirname, "../fixtures/server-signing-key.hex");
const FIXTURE_HEX = "87933b94dc0c628a4c60c6cde47fa21d09ebb927c455da4ef2f5a8f7f044e595";

function snapshotEnv(): () => void {
  const prev = {
    path: process.env.MCP_SERVER_SIGNING_KEY_PATH,
    nodeEnv: process.env.NODE_ENV,
  };
  return () => {
    if (prev.path === undefined) delete process.env.MCP_SERVER_SIGNING_KEY_PATH;
    else process.env.MCP_SERVER_SIGNING_KEY_PATH = prev.path;
    if (prev.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.nodeEnv;
  };
}

describe("server-key (FN-048)", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    __resetForTests();
  });
  afterEach(() => {
    restoreEnv();
    __resetForTests();
    vi.restoreAllMocks();
  });

  it("loads a key from MCP_SERVER_SIGNING_KEY_PATH (hex fixture)", () => {
    process.env.MCP_SERVER_SIGNING_KEY_PATH = FIXTURE_PATH;
    const k = getServerSigningKey();
    expect(k.loadedFrom).toBe("env-path");
    expect(Buffer.from(k.privateKey).toString("hex")).toBe(FIXTURE_HEX);
    // Public key is the canonical Ed25519 derivation of the seed.
    const expectedPub = ed.getPublicKey(k.privateKey);
    expect(Buffer.from(k.publicKey).toString("hex")).toBe(
      Buffer.from(expectedPub).toString("hex"),
    );
  });

  it("throws fatally in production when MCP_SERVER_SIGNING_KEY_PATH is unset", () => {
    delete process.env.MCP_SERVER_SIGNING_KEY_PATH;
    process.env.NODE_ENV = "production";
    expect(() => getServerSigningKey()).toThrow(/MCP_SERVER_SIGNING_KEY_PATH/);
  });

  it("generates an ephemeral key in non-production and warns once", () => {
    delete process.env.MCP_SERVER_SIGNING_KEY_PATH;
    process.env.NODE_ENV = "test";
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = getServerSigningKey();
    expect(k.loadedFrom).toBe("ephemeral");
    expect(k.privateKey.length).toBe(32);
    expect(k.publicKey.length).toBe(32);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/ephemeral/i);
  });

  it("memoizes — repeated calls return identical bytes", () => {
    process.env.MCP_SERVER_SIGNING_KEY_PATH = FIXTURE_PATH;
    const a = getServerSigningKey();
    const b = getServerSigningKey();
    expect(a).toBe(b);
    expect(getServerPublicKeyBytes()).toBe(a.publicKey);
  });

  it("getServerInstance returns a stable ISO timestamp across calls", () => {
    const a = getServerInstance();
    const b = getServerInstance();
    expect(a).toBe(b);
    expect(() => new Date(a).toISOString()).not.toThrow();
    expect(new Date(a).toISOString()).toBe(a);
  });
});
