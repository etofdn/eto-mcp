/**
 * Memo size budget constants. See `docs/memo-schema-registry.md` §2.
 *
 * - `MEMO_HARD_LIMIT_BYTES` is enforced by {@link encodeMemo}: oversized
 *   envelopes are rejected client-side before the transfer is signed.
 * - `MEMO_SOFT_WARN_BYTES` triggers a single warning at encode time so
 *   producers know they are eating headroom intended for SDK variation
 *   and future cosigner accounts.
 */
export const MEMO_HARD_LIMIT_BYTES = 566;
export const MEMO_SOFT_WARN_BYTES = 400;

/** Byte length of a UTF-8 string (matches what lands in instruction data). */
export function byteLengthUtf8(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
