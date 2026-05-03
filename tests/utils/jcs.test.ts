// Unit tests for the lifted RFC 8785 (JCS) canonicalizer at
// `src/utils/jcs.ts`. Mirrors and extends the inline coverage that
// previously lived alongside `bank-mock.ts`.

import { describe, expect, it } from "vitest";
import { jcsCanonicalize, jcsCompareUtf16 } from "../../src/utils/jcs.js";

describe("jcsCanonicalize — primitives", () => {
  it("encodes null, booleans, integers, and strings", () => {
    expect(jcsCanonicalize(null)).toBe("null");
    expect(jcsCanonicalize(true)).toBe("true");
    expect(jcsCanonicalize(false)).toBe("false");
    expect(jcsCanonicalize(0)).toBe("0");
    expect(jcsCanonicalize(-7)).toBe("-7");
    expect(jcsCanonicalize("hi")).toBe('"hi"');
  });

  it("throws on non-finite numbers", () => {
    expect(() => jcsCanonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(() => jcsCanonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => jcsCanonicalize(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("throws on non-integer (float) numbers", () => {
    expect(() => jcsCanonicalize(1.5)).toThrow(/non-integer/);
    expect(() => jcsCanonicalize(0.1)).toThrow(/non-integer/);
  });

  it("throws on unsupported types", () => {
    expect(() => jcsCanonicalize(undefined)).toThrow(/unsupported/);
    expect(() => jcsCanonicalize(BigInt(1))).toThrow(/unsupported/);
    expect(() => jcsCanonicalize(Symbol("x"))).toThrow(/unsupported/);
  });
});

describe("jcsCanonicalize — composite", () => {
  it("orders object keys lexicographically by UTF-16 code-unit", () => {
    const out = jcsCanonicalize({ b: 1, a: 2, "10": 3, "1": 4 });
    // "1", "10", "a", "b" — note "1" < "10" by length tie-break since
    // their first code units are equal.
    expect(out).toBe('{"1":4,"10":3,"a":2,"b":1}');
  });

  it("preserves array order (does NOT sort)", () => {
    expect(jcsCanonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("recurses through nested objects and arrays", () => {
    const v = { z: [{ b: 1, a: 2 }, 9], a: { y: 1, x: [false, true] } };
    expect(jcsCanonicalize(v)).toBe(
      '{"a":{"x":[false,true],"y":1},"z":[{"a":2,"b":1},9]}',
    );
  });

  it("is idempotent under JSON round-trip", () => {
    const v = { a: 1, b: [2, 3], c: { d: "x" } };
    const c = jcsCanonicalize(v);
    expect(jcsCanonicalize(JSON.parse(c))).toBe(c);
  });

  it("matches a hand-canonicalized fixture", () => {
    const v = { issuer: "did:eto:x", id: "urn:eto:y", n: 7 };
    expect(jcsCanonicalize(v)).toBe(
      '{"id":"urn:eto:y","issuer":"did:eto:x","n":7}',
    );
  });
});

describe("jcsCompareUtf16", () => {
  it("orders by code-unit and breaks ties by length", () => {
    expect(jcsCompareUtf16("a", "b")).toBeLessThan(0);
    expect(jcsCompareUtf16("aa", "a")).toBeGreaterThan(0);
    expect(jcsCompareUtf16("a", "a")).toBe(0);
    // 'A' (0x41) < 'a' (0x61) in UTF-16 code units.
    expect(jcsCompareUtf16("Z", "a")).toBeLessThan(0);
  });
});
