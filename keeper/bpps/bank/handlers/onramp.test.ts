/**
 * Tests for Onramp BPP handler (FN-107 / T-3.10.2.2, FN-109 / T-3.10.2.4).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeOnramp,
  stubs,
  OnrampRejected,
  type OnrampRequest,
  type OnrampDeps,
} from './onramp.js';
import { BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX } from './fee.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RECIPIENT = 'a'.repeat(64);
const TOKEN_PDA = 'b'.repeat(64);

function makeRequest(overrides: Partial<OnrampRequest> = {}): OnrampRequest {
  return {
    caller_pubkey: RECIPIENT, // FN-034: caller MUST equal recipient
    recipient: RECIPIENT,
    recipient_token_account_pda: TOKEN_PDA,
    usd_amount_cents: 10_000,        // $100.00
    funding_method: 'mock',
    external_payment_ref: 'ref-abc-12345',
    initiated_slot: 5000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OnrampDeps> = {}): OnrampDeps {
  return {
    feeFor: vi.fn((amount: number) => Math.floor(amount / 10_000)),
    verifyUsdPull: vi.fn().mockResolvedValue(true),
    mintOnChain: vi.fn().mockResolvedValue({ tx_signature: 'f'.repeat(64) }),
    remitToTreasury: vi.fn().mockResolvedValue({ tx_signature: 'a'.repeat(64) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('executeOnramp — happy path', () => {
  it('$100 → 100_000_000 gross atomic, fee 10_000 (1pip), net 99_990_000, phase=minted', async () => {
    const deps = makeDeps();
    const result = await executeOnramp(makeRequest({ usd_amount_cents: 10_000 }), deps);

    // gross = 10_000 cents * 10_000 = 100_000_000 atomic
    // fee = floor(100_000_000 / 10_000) = 10_000 atomic
    // net = 100_000_000 - 10_000 = 99_990_000
    expect(result.phase).toBe('minted');
    expect(result.eusd_amount).toBe(99_990_000);
    expect(result.fee).toBe(10_000);
    expect(result.mint_tx_signature).toBe('f'.repeat(64));
    expect(result.fulfillment_uri).toMatch(/^eto:\/\/onramp\//);
    expect(result.onramp_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('calls verifyUsdPull and mintOnChain with correct arguments', async () => {
    const deps = makeDeps();
    await executeOnramp(makeRequest(), deps);

    expect(deps.verifyUsdPull).toHaveBeenCalledOnce();
    expect(deps.verifyUsdPull).toHaveBeenCalledWith('mock', 'ref-abc-12345', 10_000);
    expect(deps.mintOnChain).toHaveBeenCalledOnce();
    expect(deps.mintOnChain).toHaveBeenCalledWith({
      recipient_token_pda: TOKEN_PDA,
      amount: 99_990_000,
    });
  });

  it('calls remitToTreasury once after successful mint (FN-109)', async () => {
    const deps = makeDeps();
    const result = await executeOnramp(makeRequest({ usd_amount_cents: 10_000 }), deps);

    expect(deps.remitToTreasury).toHaveBeenCalledOnce();
    expect(deps.remitToTreasury).toHaveBeenCalledWith({
      fee_atomic: 10_000,
      treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
      source: 'onramp',
      correlation_id: result.onramp_id,
    });
  });

  it('includes treasury_remit_tx_signature in outcome (FN-109)', async () => {
    const deps = makeDeps();
    const result = await executeOnramp(makeRequest(), deps);
    expect(result.treasury_remit_tx_signature).toBe('a'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// 1pip fee math (FN-109 contract)
// ---------------------------------------------------------------------------

describe('executeOnramp — 1pip fee math (FN-109)', () => {
  it('fee is exactly floor(eusd_gross / 10_000)', async () => {
    const deps = makeDeps();
    // $50 = 5000 cents, gross = 50_000_000, fee = floor(50_000_000/10_000) = 5_000
    const result = await executeOnramp(makeRequest({ usd_amount_cents: 5_000 }), deps);
    expect(result.fee).toBe(5_000);
    expect(result.eusd_amount).toBe(49_995_000);
  });

  it('fee is integer (floor) — verifies no fractional rounding errors', async () => {
    const deps = makeDeps();
    // 1 cent → gross=10_000, fee=floor(10_000/10_000)=1, net=9_999
    const result = await executeOnramp(makeRequest({ usd_amount_cents: 1 }), deps);
    expect(Number.isInteger(result.fee)).toBe(true);
    expect(Number.isInteger(result.eusd_amount)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('executeOnramp — invalid_pubkey', () => {
  it('throws invalid_pubkey for short recipient', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ recipient: 'tooshort' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for non-hex recipient', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ recipient: 'z'.repeat(64) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for invalid recipient_token_account_pda', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ recipient_token_account_pda: 'bad' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });
});

describe('executeOnramp — caller-binding (FN-034)', () => {
  it('rejects when caller_pubkey != recipient with caller_mismatch', async () => {
    const deps = makeDeps();
    const attacker = 'f'.repeat(64);
    await expect(
      executeOnramp(makeRequest({ caller_pubkey: attacker }), deps),
    ).rejects.toMatchObject({ reason: 'caller_mismatch' });
  });

  it('rejects without invoking verifyUsdPull / mintOnChain / remitToTreasury', async () => {
    const deps = makeDeps();
    const attacker = 'f'.repeat(64);
    await expect(
      executeOnramp(makeRequest({ caller_pubkey: attacker }), deps),
    ).rejects.toBeInstanceOf(OnrampRejected);
    expect(deps.verifyUsdPull).not.toHaveBeenCalled();
    expect(deps.mintOnChain).not.toHaveBeenCalled();
    expect(deps.remitToTreasury).not.toHaveBeenCalled();
  });

  it('rejects when caller_pubkey is not a valid hex64 with invalid_pubkey', async () => {
    const deps = makeDeps();
    await expect(
      executeOnramp(makeRequest({ caller_pubkey: 'tooshort' }), deps),
    ).rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });
});

describe('executeOnramp — invalid_amount', () => {
  it('throws invalid_amount for zero usd_amount_cents', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ usd_amount_cents: 0 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for negative usd_amount_cents', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ usd_amount_cents: -100 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for non-integer usd_amount_cents', async () => {
    const deps = makeDeps();
    await expect(executeOnramp(makeRequest({ usd_amount_cents: 99.5 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });
});

// ---------------------------------------------------------------------------
// Atomicity: USD pull failure blocks mint AND remitToTreasury
// ---------------------------------------------------------------------------

describe('executeOnramp — atomicity on USD pull failure', () => {
  it('throws usd_pull_failed; mintOnChain and remitToTreasury NOT called', async () => {
    const deps = makeDeps({
      verifyUsdPull: vi.fn().mockResolvedValue(false),
    });

    await expect(executeOnramp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'usd_pull_failed' });

    expect(deps.mintOnChain).not.toHaveBeenCalled();
    expect(deps.remitToTreasury).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mint failure — remitToTreasury NOT called
// ---------------------------------------------------------------------------

describe('executeOnramp — mint failure', () => {
  it('throws mint_failed when mintOnChain rejects; remitToTreasury NOT called', async () => {
    const deps = makeDeps({
      mintOnChain: vi.fn().mockRejectedValue(new Error('on-chain unavailable')),
    });

    await expect(executeOnramp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'mint_failed' });

    expect(deps.remitToTreasury).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('executeOnramp — onramp_id determinism', () => {
  it('same inputs produce the same onramp_id', async () => {
    const req = makeRequest();
    const result1 = await executeOnramp(req, makeDeps());
    const result2 = await executeOnramp(req, makeDeps());
    expect(result1.onramp_id).toBe(result2.onramp_id);
  });

  it('different external_payment_ref → different onramp_id (ref is in hash)', async () => {
    const result1 = await executeOnramp(makeRequest({ external_payment_ref: 'ref-111' }), makeDeps());
    const result2 = await executeOnramp(makeRequest({ external_payment_ref: 'ref-222' }), makeDeps());
    expect(result1.onramp_id).not.toBe(result2.onramp_id);
  });
});

// ---------------------------------------------------------------------------
// Smallest amount boundary
// ---------------------------------------------------------------------------

describe('executeOnramp — smallest amount (1 cent)', () => {
  it('1 cent → 10_000 gross, 1 fee, 9_999 net (not zero)', async () => {
    const deps = makeDeps();
    const result = await executeOnramp(makeRequest({ usd_amount_cents: 1 }), deps);

    // gross = 1 * 10_000 = 10_000
    // fee = floor(10_000 / 10_000) = 1
    // net = 10_000 - 1 = 9_999
    expect(result.fee).toBe(1);
    expect(result.eusd_amount).toBe(9_999);
    expect(result.phase).toBe('minted');
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke test
// ---------------------------------------------------------------------------

describe('stubs', () => {
  it('verifyUsdPull returns true', async () => {
    expect(await stubs.verifyUsdPull('mock', 'ref-test', 100)).toBe(true);
  });

  it('mintOnChain returns tx_signature of length 64', async () => {
    const { tx_signature } = await stubs.mintOnChain({
      recipient_token_pda: TOKEN_PDA,
      amount: 99_990_000,
    });
    expect(tx_signature).toHaveLength(64);
  });

  it('feeFor returns integer floor of amount/10_000', () => {
    expect(stubs.feeFor(100_000_000)).toBe(10_000);
    expect(stubs.feeFor(10_000)).toBe(1);
    expect(stubs.feeFor(9_999)).toBe(0);   // below 1pip threshold
  });

  it('remitToTreasury returns 64-hex tx_signature', async () => {
    const { tx_signature } = await stubs.remitToTreasury({
      fee_atomic: 10_000,
      treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
      source: 'onramp',
      correlation_id: '0'.repeat(64),
    });
    expect(tx_signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
