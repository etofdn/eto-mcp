/**
 * Required-credential policy for the bank-as-BPP services
 * (FN-099 / T-3.9.1.5).
 *
 * # What this module is
 *
 * This is the single source of truth for "what credentials must a BAP
 * present to invoke a bank-as-BPP service?" in v0. The catalogue JSON
 * (FN-098), the BPP runtime config (FN-096), and the per-flow BPP
 * handlers (FN-115 Open Checking, FN-121 Open Savings) all import from
 * here rather than restating policy. The runtime gate that ultimately
 * enforces this policy at Beckn `init` time lives in
 * `programs::beckn::instructions::init::effective_requirements` (FN-019);
 * the off-chain mirror lives in `keeper/lib/cred-gate.ts` (FN-074).
 *
 * # Pre-image convention (single, shared)
 *
 * Both schemas use the canonical convention
 *
 *     schema_hash = sha256(utf8("eto.beckn.schema.{label}.v1"))
 *
 * with sha2 (NOT keccak), 32-byte digest, lowercase 64-char hex (no
 * `0x` prefix). The two resulting hashes differ because the labels
 * differ (`verified-human` vs `kyc.us-test`), not because the
 * convention differs. References:
 *
 *   * `spec/issuers/worldcoin-integration.md` (FN-038, verified-human).
 *   * `spec/issuers/civic-integration.md` (FN-039, verified-human).
 *   * `eto-mcp/src/issuers/kyc-test.ts` (FN-040, kyc.us-test) —
 *     defines `KYC_TEST_SCHEMA_ID_HEX`, which we re-export verbatim.
 *
 * # Policy (v0)
 *
 *   * `bank.checking.open` and `bank.savings.open` REQUIRE both
 *     `verified-human` AND `kyc.us-test`, both `mustBeActive: true`,
 *     issuer set unconstrained (any issuer that mints the schema is
 *     accepted; pinning issuers is a future hardening task).
 *   * Every other action returns `[]` from `requiredCredsForAction`,
 *     i.e. there is NO silent inheritance of the account-open policy
 *     to e.g. `bank.fiat-ramp` or `bank.wire`.
 */

import { createHash } from "node:crypto";

import {
  zRequiredCredential,
  type Hex32,
  type RequiredCredential,
} from "../../templates/bpp/types.js";
import { KYC_TEST_SCHEMA_ID_HEX } from "../../../src/issuers/kyc-test.js";

/* -------------------------------------------------------------------------- */
/* Schema labels + hashes                                                     */
/* -------------------------------------------------------------------------- */

const HEX32_RE = /^[0-9a-f]{64}$/;

/** Pre-image label for the verified-human credential schema. */
export const VERIFIED_HUMAN_SCHEMA_LABEL =
  "eto.beckn.schema.verified-human.v1" as const;

/**
 * Pre-image label for the `kyc.us-test` credential schema. Matches
 * the byte-pre-image hashed inside `KYC_TEST_SCHEMA_ID_HEX`
 * (FN-040, `eto-mcp/src/issuers/kyc-test.ts`). Exported here so
 * downstream code can refer to one canonical label constant.
 */
export const KYC_US_TEST_SCHEMA_LABEL =
  "eto.beckn.schema.kyc.us-test.v1" as const;

/** sha256(utf8(label)) → lowercase 64-char hex of the 32-byte digest. */
function sha256HexUtf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * 32-byte schema-hash hex for `verified-human`. Computed at module
 * load via {@link sha256HexUtf8}. The same digest is what FN-038
 * (Worldcoin) and FN-039 (Civic) mint into on-chain `Credential`
 * PDAs at the `schema` seed.
 */
export const VERIFIED_HUMAN_SCHEMA_HASH_HEX: Hex32 = sha256HexUtf8(
  VERIFIED_HUMAN_SCHEMA_LABEL,
);

/**
 * 32-byte schema-hash hex for `kyc.us-test`. Re-exported verbatim
 * from FN-040's `KYC_TEST_SCHEMA_ID_HEX` so there is exactly one
 * definition site for this constant; the local re-export gives
 * callers a name that matches the policy-module convention while
 * preserving the issuer module as the source of truth.
 */
export const KYC_US_TEST_SCHEMA_HASH_HEX: Hex32 = KYC_TEST_SCHEMA_ID_HEX;

/* -------------------------------------------------------------------------- */
/* Per-service policy                                                         */
/* -------------------------------------------------------------------------- */

/** Capability actions for which the account-open policy is mandatory. */
export const ACCOUNT_OPEN_ACTIONS = [
  "bank.checking.open",
  "bank.savings.open",
] as const;

export type AccountOpenAction = (typeof ACCOUNT_OPEN_ACTIONS)[number];

/**
 * The two credentials a BAP MUST present at Beckn `init` time to
 * invoke any account-open action. Both entries are `mustBeActive`
 * (gate rejects revoked / out-of-window credentials). `issuerSet`
 * is empty: any issuer that mints the right schema is accepted in
 * v0; pinning the canonical Worldcoin / Civic / kyc-test pubkeys is
 * tracked as a follow-up hardening task.
 */
export const ACCOUNT_OPEN_REQUIRED_CREDS: readonly RequiredCredential[] =
  Object.freeze([
    Object.freeze({
      schema: VERIFIED_HUMAN_SCHEMA_HASH_HEX,
      issuerSet: Object.freeze([] as readonly string[]),
      mustBeActive: true,
    }) as RequiredCredential,
    Object.freeze({
      schema: KYC_US_TEST_SCHEMA_HASH_HEX,
      issuerSet: Object.freeze([] as readonly string[]),
      mustBeActive: true,
    }) as RequiredCredential,
  ]);

/**
 * Action → required-credentials map. Only the account-open actions
 * are keyed in v0; lookups for any other action return `[]` (see
 * {@link requiredCredsForAction}). Other bank actions
 * (`bank.fiat-ramp`, `bank.card.swipe`, `bank.wire`, ...) are
 * intentionally absent so they cannot silently inherit account-open
 * policy.
 */
export const BANK_REQUIRED_CREDS_BY_ACTION: ReadonlyMap<
  string,
  readonly RequiredCredential[]
> = new Map<string, readonly RequiredCredential[]>(
  ACCOUNT_OPEN_ACTIONS.map((a) => [a, ACCOUNT_OPEN_REQUIRED_CREDS] as const),
);

/**
 * Resolve the required-credential list for a Beckn capability action.
 * Pure, no I/O. Unknown actions return `[]` — call sites must NOT
 * treat that as "default to account-open policy".
 */
export function requiredCredsForAction(
  action: string,
): readonly RequiredCredential[] {
  return BANK_REQUIRED_CREDS_BY_ACTION.get(action) ?? [];
}

/** True iff `action` is in {@link ACCOUNT_OPEN_ACTIONS}. */
export function isAccountOpenAction(action: string): action is AccountOpenAction {
  return (ACCOUNT_OPEN_ACTIONS as readonly string[]).includes(action);
}

/* -------------------------------------------------------------------------- */
/* Load-time invariants                                                       */
/* -------------------------------------------------------------------------- */

((): void => {
  for (const hex of [
    VERIFIED_HUMAN_SCHEMA_HASH_HEX,
    KYC_US_TEST_SCHEMA_HASH_HEX,
  ]) {
    if (!HEX32_RE.test(hex)) {
      throw new Error(
        `bank/required-creds: schema hash is not 64 lowercase hex chars: ${hex}`,
      );
    }
    if (Buffer.from(hex, "hex").length !== 32) {
      throw new Error(
        `bank/required-creds: schema hash does not decode to 32 bytes: ${hex}`,
      );
    }
  }
  for (const cred of ACCOUNT_OPEN_REQUIRED_CREDS) {
    zRequiredCredential.parse(cred);
  }
})();
