/**
 * Onramp BPP handler (FN-107 / T-3.10.2.2).
 *
 * Inbound: Beckn /confirm payload from the bridge with order.items =
 *   [{ id: 'onramp-eusd', ... }].
 * Outbound: signs CompleteTask with the minted eUSD amount in the
 *   fulfillment_uri, having verified the USD pull and submitted an
 *   on-chain Mint instruction (FN-103).
 *
 * 2-phase flow:
 *   Phase 1 — verify USD pull cleared (mocked in v0: always succeeds).
 *   Phase 2 — submit on-chain Mint instruction (STUBBED in v0).
 *
 * Fee: 1pip = 0.01% per FN-109, implemented as floor(amount / 10_000).
 */

import { createHash } from 'node:crypto';

export interface OnrampRequest {
  recipient: string;                     // hex pubkey — receives the eUSD
  recipient_token_account_pda: string;   // hex — TokenAccount PDA
  usd_amount_cents: number;              // amount in USD cents (1000 = $10.00)
  funding_method: 'ach' | 'wire' | 'card' | 'mock';
  external_payment_ref: string;          // bank's reference to the USD pull
  initiated_slot: number;
}

export interface OnrampOutcome {
  onramp_id: string;
  phase: 'minted' | 'pending_pull' | 'failed';
  eusd_amount: number;         // atomic units (1 eUSD = 1_000_000)
  fee: number;                 // 1pip = 0.01% per FN-109 (atomic units)
  fulfillment_uri: string;
  mint_tx_signature?: string;
}

export interface OnrampDeps {
  /** Verify the USD pull cleared. STUB always returns true in v0. */
  verifyUsdPull: (method: OnrampRequest['funding_method'], ref: string, cents: number) => Promise<boolean>;
  /** Submit on-chain Mint instruction (FN-103). STUBBED. */
  mintOnChain: (args: { recipient_token_pda: string; amount: number }) => Promise<{ tx_signature: string }>;
  /** 1-pip fee per FN-109 (0.01% = 1 bp). Centralised so FN-109 can swap. */
  feeFor: (eusd_amount: number) => number;
}

export class OnrampRejected extends Error {
  constructor(public reason: 'invalid_pubkey' | 'invalid_amount' | 'usd_pull_failed' | 'mint_failed') {
    super('onramp rejected: ' + reason);
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** USD cents → atomic eUSD units. 1 USD = 1 eUSD = 1_000_000 atomic. */
function usdCentsToAtomicEusd(cents: number): number {
  // 1 cent = $0.01 = 0.01 eUSD = 10_000 atomic units
  return cents * 10_000;
}

export async function executeOnramp(req: OnrampRequest, deps: OnrampDeps): Promise<OnrampOutcome> {
  if (!HEX64.test(req.recipient)) throw new OnrampRejected('invalid_pubkey');
  if (!HEX64.test(req.recipient_token_account_pda)) throw new OnrampRejected('invalid_pubkey');
  if (!Number.isInteger(req.usd_amount_cents) || req.usd_amount_cents <= 0) throw new OnrampRejected('invalid_amount');

  const eusd_gross = usdCentsToAtomicEusd(req.usd_amount_cents);
  const fee = deps.feeFor(eusd_gross);
  const eusd_net = eusd_gross - fee;

  const onramp_id = createHash('sha256')
    .update('onramp')
    .update(Buffer.from(req.recipient, 'hex'))
    .update(Buffer.from(BigInt(req.usd_amount_cents).toString(16).padStart(16, '0'), 'hex'))
    .update(Buffer.from(BigInt(req.initiated_slot).toString(16).padStart(16, '0'), 'hex'))
    .update(req.external_payment_ref)
    .digest('hex');

  // Phase 1: verify USD pulled
  const pulled = await deps.verifyUsdPull(req.funding_method, req.external_payment_ref, req.usd_amount_cents);
  if (!pulled) throw new OnrampRejected('usd_pull_failed');

  // Phase 2: mint on chain
  let mint_sig: string;
  try {
    const r = await deps.mintOnChain({ recipient_token_pda: req.recipient_token_account_pda, amount: eusd_net });
    mint_sig = r.tx_signature;
  } catch {
    throw new OnrampRejected('mint_failed');
  }

  return {
    onramp_id,
    phase: 'minted',
    eusd_amount: eusd_net,
    fee,
    fulfillment_uri: `eto://onramp/${onramp_id}`,
    mint_tx_signature: mint_sig,
  };
}

/** v0 stubs. Pull always succeeds; mint logs and returns deterministic sig. */
export const stubs: OnrampDeps = {
  feeFor: (eusd_amount) => Math.floor(eusd_amount / 10_000), // 1pip = 0.01% = /10000
  verifyUsdPull: async (method, ref, cents) => {
    console.log(`[STUB] verifyUsdPull method=${method} ref=${ref.slice(0, 12)} cents=${cents} → true`);
    return true;
  },
  mintOnChain: async (args) => {
    const sig = createHash('sha256').update('mint:' + JSON.stringify(args)).digest('hex').slice(0, 64);
    console.log(`[STUB] mintOnChain recipient=${args.recipient_token_pda.slice(0, 8)} amount=${args.amount} → ${sig.slice(0, 16)}`);
    return { tx_signature: sig };
  },
};
