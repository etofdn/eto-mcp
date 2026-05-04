/**
 * FN-015 — Tests for the bank-BPP caller-authentication helper.
 */
import { describe, it, expect } from "vitest";
import {
  assertCallerEquals,
  UNAUTHORIZED_CALLER_REASON,
  type AuthenticatedRequest,
} from "./auth.js";

const SUBJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("assertCallerEquals", () => {
  it("returns silently when callerPubkey === expected", () => {
    expect(() => assertCallerEquals(SUBJECT, SUBJECT)).not.toThrow();
  });

  it("throws unauthorized_caller when callerPubkey !== expected", () => {
    expect(() => assertCallerEquals(OTHER, SUBJECT)).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
  });

  it("throws unauthorized_caller when callerPubkey is undefined", () => {
    expect(() => assertCallerEquals(undefined, SUBJECT)).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
  });

  it("throws unauthorized_caller when callerPubkey is empty string", () => {
    expect(() => assertCallerEquals("", SUBJECT)).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
  });

  it("throws unauthorized_caller when expected is empty string", () => {
    expect(() => assertCallerEquals(SUBJECT, "")).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
  });

  it("matches case-insensitively (uppercase vs lowercase hex)", () => {
    const upper = SUBJECT.toUpperCase();
    expect(() => assertCallerEquals(upper, SUBJECT)).not.toThrow();
    expect(() => assertCallerEquals(SUBJECT, upper)).not.toThrow();
  });

  it("rejects (does not panic) on differing-length input", () => {
    expect(() => assertCallerEquals("a".repeat(63), SUBJECT)).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
    expect(() => assertCallerEquals("a".repeat(65), SUBJECT)).toThrow(
      UNAUTHORIZED_CALLER_REASON,
    );
  });

  it("error message is exactly the reason constant (no leakage)", () => {
    try {
      assertCallerEquals(OTHER, SUBJECT);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe(UNAUTHORIZED_CALLER_REASON);
    }
  });

  it("AuthenticatedRequest envelope shape carries body verbatim", () => {
    interface Body {
      subject: string;
      amount: number;
    }
    const env: AuthenticatedRequest<Body> = {
      callerPubkey: SUBJECT,
      body: { subject: SUBJECT, amount: 42 },
    };
    expect(env.callerPubkey).toBe(SUBJECT);
    expect(env.body.subject).toBe(SUBJECT);
    expect(env.body.amount).toBe(42);
  });
});
