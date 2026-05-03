// JCS (RFC 8785) canonicalization — shared utility.
//
// **History.** This implementation originally lived inline in
// `src/issuers/bank-mock.ts` (FN-097). The header on that copy invited
// the *fourth* user of the helper to lift it into a shared module.
// FN-084 (Ed25519 VC signing for the audit-trail / travel-rule
// indexers) is that fourth user, so the body now lives here and
// `bank-mock.ts` re-exports `jcsCanonicalize` from this module to
// preserve its public symbol.
//
// **Scope.** Sufficient for the VC shapes ETO emits: ordered object
// keys (lexicographic over UTF-16 code units, per RFC 8785 §3.2.3),
// arrays preserved in source order, no insignificant whitespace,
// integer-only numbers (we never emit non-integer numbers in any VC).
//
// **Error semantics.** Throws on:
//   - non-finite numbers (NaN, ±Infinity)
//   - non-integer numbers (we deliberately reject floats rather than
//     paper over the IEEE-754 representation issue)
//   - unsupported types (functions, symbols, bigints, undefined)

/**
 * Canonicalize `value` per RFC 8785 (a strict subset — see file
 * header). Returns the canonical UTF-8 JSON string.
 */
export function jcsCanonicalize(value: unknown): string {
  return jcsStringify(value);
}

/**
 * Recursive serializer. Exported so callers that need the raw
 * stringifier (without the public name) can reuse it; in practice
 * `jcsCanonicalize` is the only entry point most callers want.
 */
export function jcsStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("jcsCanonicalize: non-finite number");
    }
    if (!Number.isInteger(value)) {
      throw new Error("jcsCanonicalize: non-integer numbers not supported");
    }
    return value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcsStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(jcsCompareUtf16);
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${jcsStringify(obj[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error(`jcsCanonicalize: unsupported type ${typeof value}`);
}

/** Lexicographic compare over UTF-16 code units, per RFC 8785 §3.2.3. */
export function jcsCompareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return ca - cb;
  }
  return a.length - b.length;
}
