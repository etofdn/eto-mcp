/**
 * FN-109 / T-3.10.2.4 — 1-pip fee math and treasury remittance.
 *
 * This module is the **single source of truth** for the eUSD 1-pip fee:
 *   - Fee rate : 0.01% = 1 basis-point (bp) = 1 pip
 *   - Formula  : floor(eusd_atomic / ONE_BIP_DIVISOR)
 *   - Unit     : atomic eUSD (1 eUSD = 1_000_000 atomic units)
 *
 * Acceptance criteria (FN-109):
 *   1. Fee is 0.01% of the gross eUSD amount, computed in atomic units.
 *   2. Fee is always floored (no rounding up).
 *   3. Fee is remitted to the bank treasury account after each successful
 *      onramp/offramp via `RemitToTreasury`.
 *   4. `BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX` is a v0 placeholder pending
 *      real on-chain treasury PDA derivation (see follow-up task FN-109).
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Divisor for 1-pip (1 basis-point = 0.01%) fee math.
 *
 * fee = floor(eusd_atomic / ONE_BIP_DIVISOR)
 *
 * At 1_000_000 atomic units per eUSD:
 *   - minimum non-zero fee: 1 atomic unit (at 10_000 atomic = $0.001)
 *   - fee on $100 (100_000_000 atomic): 10_000 atomic ≈ $0.01
 */
export const ONE_BIP_DIVISOR = 10_000;

/**
 * v0 placeholder for the bank treasury token account PDA (hex-encoded).
 *
 * This is a deterministic 64-hex-char ASCII placeholder derived from the
 * string `'eto.bank.treasury.eusd.v0'`. It is NOT a real on-chain address.
 *
 * **Action required (follow-up):** Replace with the real Solana PDA derived
 * from the bank program seed `['treasury', 'eusd']` before mainnet launch.
 * See follow-up task for on-chain treasury PDA derivation.
 *
 * Format: 64 lowercase hex characters (represents a 32-byte address).
 */
export const BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX: string = (() => {
  // sha256('eto.bank.treasury.eusd.v0') → 32 bytes → 64 hex chars
  return createHash('sha256').update('eto.bank.treasury.eusd.v0').digest('hex');
})();

// ---------------------------------------------------------------------------
// Fee helper
// ---------------------------------------------------------------------------

/**
 * Compute the 1-pip (0.01% = 1 basis-point) fee on a given eUSD atomic amount.
 *
 * Rules:
 *   - Returns `Math.floor(eusd_atomic / ONE_BIP_DIVISOR)`.
 *   - Returns `0` for any non-positive, non-integer, or NaN input (defensive).
 *   - Never throws; safe to call with arbitrary numeric inputs.
 *
 * FN-109 acceptance criterion: fee = floor(amount / 10_000).
 *
 * @param eusd_atomic  Gross eUSD amount in atomic units (1 eUSD = 1_000_000).
 * @returns            Fee in atomic units, always a non-negative integer.
 */
export function oneBipFee(eusd_atomic: number): number {
  if (!Number.isInteger(eusd_atomic) || eusd_atomic <= 0) return 0;
  return Math.floor(eusd_atomic / ONE_BIP_DIVISOR);
}

// ---------------------------------------------------------------------------
// RemitToTreasury interface and stub
// ---------------------------------------------------------------------------

/**
 * Arguments for a treasury remittance call.
 *
 * FN-109: fee is credited to the bank treasury account after every successful
 * onramp or offramp, using the same eUSD token program as the user transfer.
 */
export interface RemitArgs {
  /** Fee in atomic eUSD units to credit to the treasury. */
  fee_atomic: number;
  /** Hex-encoded treasury token account PDA (see `BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX`). */
  treasury_pda_hex: string;
  /** Which handler is remitting — used for audit correlation. */
  source: 'onramp' | 'offramp';
  /** Operation ID (onramp_id / offramp_id) for end-to-end correlation. */
  correlation_id: string;
}

/**
 * Treasury remittance hook.
 *
 * Called after every successful onramp/offramp to credit the 1-pip fee to
 * the bank treasury token account. In v0 this is a stub; the real
 * implementation submits a Solana SPL-token transfer instruction.
 *
 * Returning `{ tx_signature }` allows callers to include the remit tx in
 * the operation outcome for audit trail.
 *
 * FN-109 contract: implementations MUST be deterministic (identical args →
 * identical `tx_signature`) so that replaying a failed handler is idempotent.
 */
export type RemitToTreasury = (args: RemitArgs) => Promise<{ tx_signature: string }>;

/** Sentinel returned by `stubRemitToTreasury` when `fee_atomic === 0`. */
const ZERO_FEE_SENTINEL = '0'.repeat(64);

/**
 * v0 stub implementation of `RemitToTreasury`.
 *
 * Behaviour:
 *   - When `fee_atomic === 0`: skips the remit (returns the all-zero sentinel
 *     `'0'.repeat(64)`) so the call-site stays uniform without a network hop.
 *   - Otherwise: logs the remit and returns a deterministic `tx_signature`
 *     derived from `sha256('treasury:' + JSON.stringify(args))`.
 *
 * Determinism guarantee: identical args always yield the same `tx_signature`,
 * making the handler safe to replay on retry.
 *
 * **Follow-up:** Replace with a real SPL-token transfer to
 * `BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX` when the on-chain program is live.
 */
export const stubRemitToTreasury: RemitToTreasury = async (args: RemitArgs): Promise<{ tx_signature: string }> => {
  if (args.fee_atomic === 0) {
    return { tx_signature: ZERO_FEE_SENTINEL };
  }
  const tx_signature = createHash('sha256')
    .update('treasury:' + JSON.stringify(args))
    .digest('hex');
  console.log(
    `[STUB] remitToTreasury source=${args.source} fee=${args.fee_atomic} ` +
    `corr=${args.correlation_id.slice(0, 12)} → ${tx_signature.slice(0, 16)}`,
  );
  return { tx_signature };
};
