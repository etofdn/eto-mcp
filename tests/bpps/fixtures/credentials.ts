/**
 * Fixture credentials for the BPP e2e test suite (FN-082).
 *
 * Uses the canonical verified-human schema hash from the bank BPP's
 * required-creds module — the same source the production gate consults —
 * so fixtures and production policy share a single truth.
 */

import type { HeldCredentialSnapshot, Pubkey } from "../../../keeper/templates/bpp/types.js";
import { VERIFIED_HUMAN_SCHEMA_HASH_HEX } from "../../../keeper/bpps/bank/required-creds.js";

export { VERIFIED_HUMAN_SCHEMA_HASH_HEX };

/**
 * Fake issuer pubkey used in e2e tests. Must be a plausible-looking
 * 32–44-char string for `zRequiredCredential` validation (issuerSet items
 * pass through `zPubkey = z.string().min(32).max(64)`).
 */
export const FAKE_ISSUER: Pubkey =
  "FakeIssuerAuthority11111111111111111111111111";

/**
 * Mint a fake `verified-human` credential for the given BAP authority.
 * Returns a fully-populated `HeldCredentialSnapshot` that satisfies the
 * `defaultCredentialGate` check when `mustBeActive = true` and `now()`
 * is in the `[validFrom, validUntil]` window (both 0 ⇒ no window).
 */
export function mintVerifiedHumanCred(
  bapAuthority: Pubkey,
): HeldCredentialSnapshot {
  void bapAuthority; // authority is the holder; included for self-documentation
  return {
    schema: VERIFIED_HUMAN_SCHEMA_HASH_HEX,
    predicateHash: "0".repeat(64),
    issuer: FAKE_ISSUER,
    validFrom: 0, // no lower bound
    validUntil: 0, // no upper bound
    revoked: false,
  };
}
