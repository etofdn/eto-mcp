/**
 * Offramp BPP handler (FN-108 / T-3.10.2.3).
 *
 * Inbound: Beckn /confirm payload from the bridge with order.items =
 *   [{ id: 'offramp-eusd', ... }].
 * Outbound: signs CompleteTask with the USD amount pushed in the
 *   fulfillment_uri, having burned the eUSD on chain (FN-104) and
 *   submitted a USD push to the external bank account (mocked in v0).
 *
 * 2-phase flow:
 *   Phase 1 — burn eUSD on chain (FN-104, STUBBED in v0).
 *   Phase 2 — push USD to external bank account (STUB always succeeds in v0).
 *
 * Atomicity note: eUSD is burned in Phase 1 before the USD push in Phase 2.
 * If Phase 2 (pushUsd) fails AFTER Phase 1 (burnOnChain) succeeds, the eUSD
 * is already gone from the chain. There is no on-chain rollback. Real systems
 * pre-fund a USD treasury and reverse with a re-mint on failure; v0 instead
 * calls flagReconciliation so operations staff can handle it manually.
 *
 * Fee: 1pip = 0.01% per FN-109, centralised in `./fee.ts`.
 * Treasury remittance: after a successful USD push, the fee is remitted to the
 *   bank treasury account via `deps.remitToTreasury` (FN-109 acceptance
 *   criterion). The resulting tx_signature is included in the outcome.
 *
 * NOTE: remitToTreasury is NOT called when burn_failed or push_failed_post_burn
 *   because the fee is only realised once the full offramp completes (the USD
 *   push succeeded). In the post-burn / push-failure path the fee is not yet
 *   earned — reconciliation handles the corrective action.
 */

import { createHash } from 'node:crypto';
import {
  oneBipFee,
  BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
  stubRemitToTreasury,
  type RemitToTreasury,
} from './fee.js';

export interface OfframpRequest {
  /**
   * FN-034: authenticated caller pubkey (hex). MUST equal `holder` —
   * any mismatch is rejected with `caller_mismatch` before any side-effect
   * runs. Without this binding, an unauthenticated caller could burn eUSD
   * and push USD on behalf of any subject.
   */
  caller_pubkey: string;
  holder: string;                     // hex pubkey burning eUSD
  holder_token_account_pda: string;   // hex — TokenAccount being burned from
  eusd_amount_atomic: number;         // atomic eUSD units (1 eUSD = 1_000_000)
  destination: {
    account_holder_name: string;
    routing_number?: string;          // domestic ACH/wire
    account_number?: string;
    swift_bic?: string;               // international wire
    iban?: string;
  };
  initiated_slot: number;
}

export interface OfframpOutcome {
  offramp_id: string;
  phase: 'pushed' | 'burned_pending_push' | 'failed';
  burned_atomic: number;
  fee_atomic: number;                 // 1pip
  usd_cents_pushed: number;
  fulfillment_uri: string;
  burn_tx_signature?: string;
  external_ref?: string;
  /** tx_signature of the treasury remittance for the 1-pip fee (FN-109). */
  treasury_remit_tx_signature?: string;
}

export interface OfframpDeps {
  /** Submit on-chain Burn instruction (FN-104). STUBBED. */
  burnOnChain: (args: { holder_token_pda: string; amount: number }) => Promise<{ tx_signature: string }>;
  /** Push USD to external bank account. STUB always succeeds. */
  pushUsd: (cents: number, dest: OfframpRequest['destination']) => Promise<{ external_ref: string }>;
  /** Open a manual-reconcile case if burn succeeds but push fails. STUBBED — real impl wakes ops. */
  flagReconciliation: (offramp_id: string, holder: string, burned_atomic: number) => Promise<void>;
  /**
   * 1-pip fee per FN-109 (0.01%). Defaults to `oneBipFee` from fee.ts.
   * Kept as injectable dep for test/mock overrides; do NOT remove.
   */
  feeFor: (eusd_amount: number) => number;
  /**
   * Remit the 1-pip fee to the bank treasury after a successful push (FN-109).
   * Called only on the happy path (phase === 'pushed'). NOT called when
   * burn_failed or push_failed_post_burn — see module doc for rationale.
   */
  remitToTreasury: RemitToTreasury;
}

export class OfframpRejected extends Error {
  constructor(public reason: 'invalid_pubkey' | 'caller_mismatch' | 'invalid_amount' | 'destination_invalid' | 'burn_failed' | 'push_failed_post_burn') {
    super('offramp rejected: ' + reason);
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Atomic eUSD → USD cents. 1 eUSD = 100 cents = 1_000_000 atomic. So 1 cent = 10_000 atomic. */
function atomicEusdToUsdCents(atomic: number): number {
  return Math.floor(atomic / 10_000);
}

export async function executeOfframp(req: OfframpRequest, deps: OfframpDeps): Promise<OfframpOutcome> {
  if (!HEX64.test(req.caller_pubkey)) throw new OfframpRejected('invalid_pubkey');
  if (!HEX64.test(req.holder)) throw new OfframpRejected('invalid_pubkey');
  if (!HEX64.test(req.holder_token_account_pda)) throw new OfframpRejected('invalid_pubkey');
  // FN-034: caller-binding. Reject before any side-effect when the caller
  // is not the holder; otherwise an unauth'd caller could burn another
  // subject's eUSD and direct the USD push.
  if (req.caller_pubkey !== req.holder) throw new OfframpRejected('caller_mismatch');
  if (!Number.isInteger(req.eusd_amount_atomic) || req.eusd_amount_atomic <= 0) throw new OfframpRejected('invalid_amount');
  if (!req.destination.account_holder_name) throw new OfframpRejected('destination_invalid');
  // At least one routing pair must be present
  const hasDomestic = !!req.destination.routing_number && !!req.destination.account_number;
  const hasIntl = !!req.destination.swift_bic;
  if (!hasDomestic && !hasIntl) throw new OfframpRejected('destination_invalid');

  const fee = deps.feeFor(req.eusd_amount_atomic);
  const eusd_net = req.eusd_amount_atomic - fee;
  if (eusd_net <= 0) throw new OfframpRejected('invalid_amount'); // fee exceeds amount
  const usd_cents = atomicEusdToUsdCents(eusd_net);

  const offramp_id = createHash('sha256')
    .update('offramp')
    .update(Buffer.from(req.holder, 'hex'))
    .update(Buffer.from(BigInt(req.eusd_amount_atomic).toString(16).padStart(16, '0'), 'hex'))
    .update(Buffer.from(BigInt(req.initiated_slot).toString(16).padStart(16, '0'), 'hex'))
    .update(JSON.stringify(req.destination))
    .digest('hex');

  // Phase 1: burn eUSD on chain
  let burn_sig: string;
  try {
    const r = await deps.burnOnChain({ holder_token_pda: req.holder_token_account_pda, amount: req.eusd_amount_atomic });
    burn_sig = r.tx_signature;
  } catch {
    throw new OfframpRejected('burn_failed');
  }

  // Phase 2: push USD. NOTE: if this fails, eUSD is already burned (real systems
  // pre-fund a USD treasury and reverse with a re-mint; v0 just flags for ops).
  // FN-109: remitToTreasury is NOT called in the push-failure path because the
  // fee is only earned when the full offramp completes successfully.
  let push_external_ref: string;
  try {
    const push = await deps.pushUsd(usd_cents, req.destination);
    push_external_ref = push.external_ref;
  } catch {
    await deps.flagReconciliation(offramp_id, req.holder, req.eusd_amount_atomic);
    throw new OfframpRejected('push_failed_post_burn');
  }

  // FN-109: remit fee to bank treasury after successful push. Called
  // unconditionally — stub short-circuits when fee === 0 so we never branch here.
  const remit = await deps.remitToTreasury({
    fee_atomic: fee,
    treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
    source: 'offramp',
    correlation_id: offramp_id,
  });

  return {
    offramp_id,
    phase: 'pushed',
    burned_atomic: req.eusd_amount_atomic,
    fee_atomic: fee,
    usd_cents_pushed: usd_cents,
    fulfillment_uri: `eto://offramp/${offramp_id}`,
    burn_tx_signature: burn_sig,
    external_ref: push_external_ref,
    treasury_remit_tx_signature: remit.tx_signature,
  };
}

/** v0 stubs. */
export const stubs: OfframpDeps = {
  feeFor: oneBipFee,
  remitToTreasury: stubRemitToTreasury,
  burnOnChain: async (args) => {
    const sig = createHash('sha256').update('burn:' + JSON.stringify(args)).digest('hex').slice(0, 64);
    console.log(`[STUB] burnOnChain holder=${args.holder_token_pda.slice(0, 8)} amount=${args.amount} → ${sig.slice(0, 16)}`);
    return { tx_signature: sig };
  },
  pushUsd: async (cents, dest) => {
    const ref = createHash('sha256').update(`push:${cents}:${JSON.stringify(dest)}`).digest('hex').slice(0, 16);
    console.log(`[STUB] pushUsd cents=${cents} dest=${dest.account_holder_name} → ext=${ref}`);
    return { external_ref: ref };
  },
  flagReconciliation: async (id, holder, burned) => {
    console.warn(`[STUB] RECONCILE NEEDED offramp=${id.slice(0, 12)} holder=${holder.slice(0, 8)} burned=${burned} (push failed post-burn)`);
  },
};
