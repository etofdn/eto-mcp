/**
 * Caller-authentication primitives for Bank BPP handlers (FN-015).
 *
 * This module enforces **caller authentication only**. It does NOT validate
 * credential presence, account ownership, or issuer authority. Those are
 * separate layers handled elsewhere:
 *
 *   - `verifyHolderCredentials` (issue-card, open-checking) — checks that the
 *     subject holds required on-chain credentials. NOT caller auth.
 *   - `verifyCheckingCredential` (open-savings) — checks that the subject has
 *     an account.checking credential. NOT caller auth.
 *   - `verifyLinkedAccount` (issue-card) — checks that a CheckingAccount PDA
 *     exists and is owned by the holder. NOT caller auth.
 *   - `verifyUsdPull` (onramp) — checks that an off-chain USD payment cleared.
 *     NOT caller auth.
 *   - `cred.issuer === bankIssuerAuthorityPubkey` (prod adapters) — checks
 *     that the credential being issued is signed by the configured bank
 *     authority. NOT caller auth.
 *
 * Caller authentication is the binding from the inbound Beckn caller's
 * verified BAP-signature pubkey to the principal named in the request body
 * (subject / holder / recipient). Without this binding any party that
 * knows a victim's pubkey can drive money-moving handlers against the victim.
 *
 * Today the gateway / bridge does NOT yet pass a verified caller pubkey down
 * to handlers — see `src/gateway/inbound-bap.ts`. This module defines the
 * contract the gateway MUST satisfy; until it does, handler call sites that
 * do not have a verified caller available will fail closed.
 *
 * Do NOT conflate the credential-validity layer with this auth layer.
 */

/**
 * Envelope wrapping a Bank BPP handler request body with the verified
 * caller pubkey extracted from the inbound BAP signature.
 *
 * `callerPubkey` MUST be a 64-character hex string (32-byte Ed25519 pubkey
 * encoded as lowercase or uppercase hex). Comparison against the body's
 * owner field is case-insensitive.
 *
 * `body` is the original handler request, untouched.
 */
export interface AuthenticatedRequest<T> {
  readonly callerPubkey: string;
  readonly body: T;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Thrown when caller authentication fails — either because the pubkey is
 * malformed (not hex64) or because it does not match the request's owner
 * field. Handlers translate this into their own `*Rejected("unauthorized_caller")`
 * error so the public error contract stays handler-local.
 */
export class UnauthorizedCallerError extends Error {
  readonly callerPubkey: string;
  readonly expected: string;
  readonly handler: string;

  constructor(callerPubkey: string, expected: string, handler: string) {
    const callerShort = String(callerPubkey ?? "").slice(0, 8);
    const expectedShort = String(expected ?? "").slice(0, 8);
    super(
      `unauthorized_caller: ${handler} expected=${expectedShort} got=${callerShort}`,
    );
    this.name = "UnauthorizedCallerError";
    this.callerPubkey = callerPubkey;
    this.expected = expected;
    this.handler = handler;
  }
}

/**
 * Assert that `req.callerPubkey` matches `expected` (case-insensitive).
 *
 * Throws `UnauthorizedCallerError` if the caller pubkey is malformed
 * (not hex64) or does not match the expected principal.
 *
 * `handler` is the human-readable handler name used for the error message
 * (e.g. "issue-card", "open-checking", "offramp", "onramp", "open-savings",
 * "wire").
 */
export function assertCallerMatches(
  req: AuthenticatedRequest<unknown>,
  expected: string,
  handler: string,
): void {
  const caller = req.callerPubkey;
  if (typeof caller !== "string" || !HEX64.test(caller)) {
    throw new UnauthorizedCallerError(
      typeof caller === "string" ? caller : "",
      expected,
      handler,
    );
  }
  if (caller.toLowerCase() !== expected.toLowerCase()) {
    throw new UnauthorizedCallerError(caller, expected, handler);
  }
}
