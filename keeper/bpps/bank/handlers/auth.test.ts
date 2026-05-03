/**
 * Tests for the Bank BPP handler caller-authentication primitive (FN-015).
 */

import { describe, it, expect } from "vitest";
import {
  assertCallerMatches,
  UnauthorizedCallerError,
  type AuthenticatedRequest,
} from "./auth.js";

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
const PUB_A_UPPER = "A".repeat(64);

function authReq<T>(callerPubkey: string, body: T): AuthenticatedRequest<T> {
  return { callerPubkey, body };
}

describe("assertCallerMatches — happy path", () => {
  it("returns void when callerPubkey === expected (lowercase)", () => {
    expect(() =>
      assertCallerMatches(authReq(PUB_A, { x: 1 }), PUB_A, "issue-card"),
    ).not.toThrow();
  });

  it("is case-insensitive: uppercase caller, lowercase expected", () => {
    expect(() =>
      assertCallerMatches(authReq(PUB_A_UPPER, {}), PUB_A, "open-checking"),
    ).not.toThrow();
  });

  it("is case-insensitive: lowercase caller, uppercase expected", () => {
    expect(() =>
      assertCallerMatches(authReq(PUB_A, {}), PUB_A_UPPER, "open-checking"),
    ).not.toThrow();
  });
});

describe("assertCallerMatches — mismatch", () => {
  it("throws UnauthorizedCallerError when caller != expected", () => {
    expect(() =>
      assertCallerMatches(authReq(PUB_B, {}), PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });

  it("error captures handler, callerPubkey, and expected", () => {
    try {
      assertCallerMatches(authReq(PUB_B, {}), PUB_A, "wire");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedCallerError);
      const err = e as UnauthorizedCallerError;
      expect(err.handler).toBe("wire");
      expect(err.callerPubkey).toBe(PUB_B);
      expect(err.expected).toBe(PUB_A);
    }
  });

  it("error message includes handler and truncated 8-char pubkeys", () => {
    try {
      assertCallerMatches(authReq(PUB_B, {}), PUB_A, "onramp");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as UnauthorizedCallerError;
      expect(err.message).toBe(
        `unauthorized_caller: onramp expected=${PUB_A.slice(0, 8)} got=${PUB_B.slice(0, 8)}`,
      );
    }
  });
});

describe("assertCallerMatches — malformed callerPubkey", () => {
  it("throws when callerPubkey is empty string", () => {
    expect(() =>
      assertCallerMatches(authReq("", {}), PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });

  it("throws when callerPubkey is too short", () => {
    expect(() =>
      assertCallerMatches(authReq("abc", {}), PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });

  it("throws when callerPubkey is too long (65 chars)", () => {
    expect(() =>
      assertCallerMatches(authReq("a".repeat(65), {}), PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });

  it("throws when callerPubkey contains non-hex characters", () => {
    expect(() =>
      assertCallerMatches(authReq("z".repeat(64), {}), PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });

  it("throws when callerPubkey is not a string", () => {
    const bad = { callerPubkey: 123 as unknown as string, body: {} };
    expect(() =>
      assertCallerMatches(bad, PUB_A, "issue-card"),
    ).toThrow(UnauthorizedCallerError);
  });
});
