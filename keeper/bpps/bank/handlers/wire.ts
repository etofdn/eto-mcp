/**
 * Wire transfer BPP handler (FN-119 / T-3.11.1.6).
 *
 * v0 flow: lock eUSD from CheckingAccount → mock wire-receipt confirmation
 * → release escrow. Real wire integration (Fedwire, SWIFT) is v1.
 *
 * The handler returns a transactional result with explicit `phase` so the
 * caller (gateway) can decide whether to ACK immediately (lock done) or
 * wait for receipt (release done).
 */

import { createHash } from 'node:crypto';

export type WireKind = 'domestic' | 'international';

export interface WireRequest {
  /**
   * FN-034: authenticated caller pubkey (hex). MUST equal `holder` —
   * any mismatch is rejected with `caller_mismatch` before any side-effect
   * runs. Without this binding, an unauthenticated caller could move money
   * for any subject.
   */
  caller_pubkey: string;
  /** Holder pubkey (hex). */
  holder: string;
  /** Holder's CheckingAccount PDA (hex). */
  checking_account_pda: string;
  /** Amount in atomic eUSD units (1 eUSD = 1_000_000). */
  amount: number;
  /** Recipient external bank routing info — opaque blob in v0. */
  recipient: {
    routing_number?: string;
    account_number?: string;
    swift_bic?: string;
    iban?: string;
    name: string;
  };
  /** Optional memo. */
  memo?: string;
  kind: WireKind;
  /** Slot at which the wire was initiated. */
  initiated_slot: number;
}

export interface WireOutcome {
  wire_id: string;                    // deterministic hash
  phase: 'locked' | 'released' | 'failed';
  amount: number;
  fee: number;                        // bank fee in atomic eUSD
  fulfillment_uri: string;
  receipt?: { confirmed_at_slot: number; external_ref: string };
}

export interface WireDeps {
  /** Pre-debit the CheckingAccount for amount + fee, transferring to escrow. STUBBED. */
  lockEscrow: (args: { holder: string; checking_pda: string; amount: number; fee: number; wire_id: string }) => Promise<{ tx_signature: string }>;
  /** Release escrow to external rails (or mock). STUBBED — v0 just logs. */
  releaseEscrow: (args: { wire_id: string; recipient: WireRequest['recipient']; amount: number }) => Promise<{ external_ref: string; confirmed_at_slot: number }>;
  /** Refund the holder if the wire ultimately fails. STUBBED. */
  refundEscrow: (args: { wire_id: string; holder: string; amount: number; fee: number }) => Promise<{ tx_signature: string }>;
  /** Bank fee schedule in atomic eUSD — domestic vs international. */
  feeFor: (kind: WireKind, amount: number) => number;
}

export class WireRejected extends Error {
  constructor(public reason: 'invalid_pubkey' | 'caller_mismatch' | 'invalid_amount' | 'recipient_invalid' | 'lock_failed' | 'release_failed') {
    super('wire rejected: ' + reason);
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export async function executeWire(req: WireRequest, deps: WireDeps): Promise<WireOutcome> {
  // Validation
  if (!HEX64.test(req.caller_pubkey)) throw new WireRejected('invalid_pubkey');
  if (!HEX64.test(req.holder)) throw new WireRejected('invalid_pubkey');
  if (!HEX64.test(req.checking_account_pda)) throw new WireRejected('invalid_pubkey');
  // FN-034: caller-binding. Reject before any side-effect when the caller
  // is not the holder; otherwise an unauth'd caller could move money for
  // any subject.
  if (req.caller_pubkey !== req.holder) throw new WireRejected('caller_mismatch');
  if (!Number.isInteger(req.amount) || req.amount <= 0) throw new WireRejected('invalid_amount');
  if (req.kind === 'domestic' && !req.recipient.routing_number) throw new WireRejected('recipient_invalid');
  if (req.kind === 'international' && !req.recipient.swift_bic) throw new WireRejected('recipient_invalid');
  if (!req.recipient.name) throw new WireRejected('recipient_invalid');

  const fee = deps.feeFor(req.kind, req.amount);
  const total = req.amount + fee;
  // Deterministic wire_id — derived from holder + amount + initiated_slot + recipient hash
  const wire_id = createHash('sha256')
    .update('wire')
    .update(Buffer.from(req.holder, 'hex'))
    .update(Buffer.from(BigInt(total).toString(16).padStart(16, '0'), 'hex'))
    .update(Buffer.from(BigInt(req.initiated_slot).toString(16).padStart(16, '0'), 'hex'))
    .update(req.kind)
    .update(JSON.stringify(req.recipient))
    .digest('hex');

  // Phase 1: lock
  try {
    await deps.lockEscrow({ holder: req.holder, checking_pda: req.checking_account_pda, amount: req.amount, fee, wire_id });
  } catch {
    throw new WireRejected('lock_failed');
  }

  // Phase 2: release
  try {
    const r = await deps.releaseEscrow({ wire_id, recipient: req.recipient, amount: req.amount });
    return {
      wire_id,
      phase: 'released',
      amount: req.amount,
      fee,
      fulfillment_uri: `eto://wire/${wire_id}`,
      receipt: { confirmed_at_slot: r.confirmed_at_slot, external_ref: r.external_ref },
    };
  } catch {
    // Release failed — refund the holder (best-effort; real impl uses 2-phase commit)
    try { await deps.refundEscrow({ wire_id, holder: req.holder, amount: req.amount, fee }); } catch {}
    throw new WireRejected('release_failed');
  }
}

/** Default v0 stubs — domestic 5 USD ($5_000_000 atomic), international 25 USD ($25_000_000) flat fees. */
export const stubs: WireDeps = {
  feeFor: (kind, _amount) => kind === 'domestic' ? 5_000_000 : 25_000_000,
  lockEscrow: async (args) => {
    const sig = createHash('sha256').update('lock:' + JSON.stringify(args)).digest('hex').slice(0, 64);
    console.log(`[STUB] lockEscrow wire=${args.wire_id.slice(0, 8)} amount=${args.amount} fee=${args.fee} → ${sig.slice(0, 16)}`);
    return { tx_signature: sig };
  },
  releaseEscrow: async (args) => {
    const ref = createHash('sha256').update('ext:' + args.wire_id).digest('hex').slice(0, 16);
    console.log(`[STUB] releaseEscrow wire=${args.wire_id.slice(0, 8)} → external_ref=${ref}`);
    return { external_ref: ref, confirmed_at_slot: Date.now() };
  },
  refundEscrow: async (args) => {
    const sig = createHash('sha256').update('refund:' + JSON.stringify(args)).digest('hex').slice(0, 64);
    console.log(`[STUB] refundEscrow wire=${args.wire_id.slice(0, 8)} → ${sig.slice(0, 16)}`);
    return { tx_signature: sig };
  },
};
