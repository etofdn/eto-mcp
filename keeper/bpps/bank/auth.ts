/**
 * FN-015 — Caller-authentication contract for bank BPP handlers.
 *
 * This module defines the shared `AuthenticatedRequest<T>` envelope and the
 * `assertCallerEquals` helper that money / identity-binding bank BPP handlers
 * use to bind a verified caller pubkey to the per-handler request body.
 *
 * ## What this is — and what it is NOT
 *
 * `assertCallerEquals` checks **caller-message-authorship authentication**:
 * the on-the-wire principal whose signature was verified by the gateway must
 * match the `subject` (or other actor) named inside the body of the Beckn
 * message before any side effect runs.
 *
 * It is NOT a credential-validity check. The following are credential /
 * issuance-side checks that DO NOT substitute for caller authentication —
 * they MUST NOT be repurposed as such:
 *
 *   - `verifyHolderCredentials` — checks whether a subject possesses
 *     required on-chain credentials. It says nothing about who sent the
 *     current message.
 *   - `verifyLinkedAccount` — checks ledger-side ownership of an account
 *     PDA. Same caveat.
 *   - `verifyCheckingCredential` (and similar) — checks issuance metadata
 *     of an existing credential.
 *   - `cred.issuer === bankIssuer.issuerAuthorityPubkey` — adapter-side
 *     guard that the bank is signing with the right authority key. It does
 *     not bind the caller's BAP signature to `cred.subject`.
 *
 * The verified `callerPubkey` is sourced from the gateway-level BAP
 * signature verification (FN-073 / FN-075). Until that plumbing lands,
 * the dispatcher (`handler.ts`) returns `undefined` for `callerPubkey`,
 * and per-capability handlers fail-closed via this module's
 * `unauthorized_caller` reason.
 *
 * @see FN-034 — apply this contract to wire / offramp / onramp / open-savings
 * @see FN-073 / FN-075 — gateway-level BAP signature plumbing that will
 *   populate `callerPubkey` for real.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types & constants
// ---------------------------------------------------------------------------

/**
 * Generic envelope wrapping a per-handler request body with the verified
 * caller pubkey produced by gateway-level BAP signature verification.
 *
 * The envelope is intentionally additive: `body` carries the existing
 * per-handler request shape verbatim. Handlers should read business
 * fields from `req.body.<field>` and authorisation context from
 * `req.callerPubkey`.
 *
 * `callerPubkey` is the lower-cased hex-encoded ed25519 public key of
 * the BAP whose signature was verified by the gateway. If the gateway
 * could not verify a signature it MUST omit `callerPubkey` (or set it
 * to the empty string) — handlers will reject such requests with
 * {@link UNAUTHORIZED_CALLER_REASON}.
 */
export interface AuthenticatedRequest<T> {
  readonly callerPubkey: string;
  readonly body: T;
}

/**
 * Canonical rejection reason emitted by handlers when caller-authentication
 * fails. Per-handler `*Rejected` error classes extend their reason union
 * with this literal so callers can switch on it.
 */
export const UNAUTHORIZED_CALLER_REASON = "unauthorized_caller" as const;

/**
 * Type alias for the literal value, useful for handler reason unions.
 */
export type UnauthorizedCallerReason = typeof UNAUTHORIZED_CALLER_REASON;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Assert that the verified caller pubkey matches `expected`.
 *
 * Throws an `Error` whose `message` is exactly `"unauthorized_caller"`
 * when:
 *   - `callerPubkey` is `undefined`, `null`, or empty
 *   - `expected` is empty
 *   - the two values differ in length (after lowercasing)
 *   - the two values differ in content (constant-time-ish via
 *     `timingSafeEqual` over equal-length `Buffer`s)
 *
 * Comparison is case-insensitive over hex (both sides are lowercased
 * before comparison). The function NEVER reveals which input was
 * malformed in the error message — the message is always the bare
 * reason constant so callers can rethrow as their typed `*Rejected`
 * error without leaking timing or validation detail.
 *
 * Reminder: this is caller-message-authorship authentication. See the
 * module-level JSDoc — credential-validity checks are NOT a substitute
 * for this gate.
 *
 * @param callerPubkey - lower- or upper-case hex pubkey reported by the
 *   gateway's BAP signature verifier; `undefined` / empty means
 *   "gateway did not verify a caller".
 * @param expected - the pubkey the request body claims to act on
 *   (typically `req.body.subject`).
 */
export function assertCallerEquals(
  callerPubkey: string | undefined,
  expected: string,
): void {
  if (
    callerPubkey === undefined ||
    callerPubkey === null ||
    callerPubkey.length === 0 ||
    expected.length === 0
  ) {
    throw new Error(UNAUTHORIZED_CALLER_REASON);
  }

  const a = callerPubkey.toLowerCase();
  const b = expected.toLowerCase();

  if (a.length !== b.length) {
    // Differing lengths can never be equal; reject without invoking
    // `timingSafeEqual` (which throws on mismatched lengths).
    throw new Error(UNAUTHORIZED_CALLER_REASON);
  }

  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");

  if (!timingSafeEqual(aBuf, bBuf)) {
    throw new Error(UNAUTHORIZED_CALLER_REASON);
  }
}
