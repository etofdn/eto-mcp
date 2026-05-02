/**
 * Tests for FN-109 fee math — fee.ts
 *
 * Covers:
 *   - oneBipFee: exact values, flooring, defensive inputs
 *   - BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX: format
 *   - stubRemitToTreasury: tx_signature shape, zero-fee sentinel, determinism
 */

import { describe, it, expect } from 'vitest';
import {
  ONE_BIP_DIVISOR,
  BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
  oneBipFee,
  stubRemitToTreasury,
} from './fee.js';

// ---------------------------------------------------------------------------
// ONE_BIP_DIVISOR
// ---------------------------------------------------------------------------

describe('ONE_BIP_DIVISOR', () => {
  it('equals 10_000 (1bp = 0.01% = 1/10000)', () => {
    expect(ONE_BIP_DIVISOR).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// oneBipFee — exact values
// ---------------------------------------------------------------------------

describe('oneBipFee — exact values', () => {
  it('oneBipFee(100_000_000) === 10_000', () => {
    expect(oneBipFee(100_000_000)).toBe(10_000);
  });

  it('oneBipFee(10_000) === 1', () => {
    expect(oneBipFee(10_000)).toBe(1);
  });

  it('oneBipFee(9_999) === 0 (below 1pip threshold)', () => {
    expect(oneBipFee(9_999)).toBe(0);
  });

  it('oneBipFee(1) === 0', () => {
    expect(oneBipFee(1)).toBe(0);
  });

  it('oneBipFee(0) === 0', () => {
    expect(oneBipFee(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// oneBipFee — flooring (no rounding up)
// ---------------------------------------------------------------------------

describe('oneBipFee — flooring', () => {
  it('oneBipFee(19_999) === 1 (not 2)', () => {
    expect(oneBipFee(19_999)).toBe(1);
  });

  it('oneBipFee(10_001) === 1 (still 1, not 2)', () => {
    expect(oneBipFee(10_001)).toBe(1);
  });

  it('oneBipFee(20_000) === 2', () => {
    expect(oneBipFee(20_000)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// oneBipFee — defensive inputs
// ---------------------------------------------------------------------------

describe('oneBipFee — defensive inputs', () => {
  it('returns 0 for negative input', () => {
    expect(oneBipFee(-1)).toBe(0);
    expect(oneBipFee(-100_000_000)).toBe(0);
  });

  it('returns 0 for non-integer (fractional)', () => {
    expect(oneBipFee(10_000.5)).toBe(0);
    expect(oneBipFee(99.9)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(oneBipFee(NaN)).toBe(0);
  });

  it('returns 0 for Infinity (non-integer)', () => {
    // Infinity is not an integer per Number.isInteger
    expect(oneBipFee(Infinity)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// oneBipFee — large amount
// ---------------------------------------------------------------------------

describe('oneBipFee — large amount', () => {
  it('MAX_SAFE_INTEGER returns an integer <= MAX_SAFE_INTEGER', () => {
    const fee = oneBipFee(Number.MAX_SAFE_INTEGER);
    expect(Number.isInteger(fee)).toBe(true);
    expect(fee).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(fee).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX
// ---------------------------------------------------------------------------

describe('BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX', () => {
  it('matches /^[0-9a-f]{64}$/ (64 lowercase hex chars)', () => {
    expect(BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a fixed deterministic value (not random)', async () => {
    // Importing the same constant twice should give the same value
    const { BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX: second } = await import('./fee.js');
    expect(BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// stubRemitToTreasury
// ---------------------------------------------------------------------------

const BASE_ARGS = {
  fee_atomic: 10_000,
  treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
  source: 'onramp' as const,
  correlation_id: 'a'.repeat(64),
};

describe('stubRemitToTreasury — tx_signature shape', () => {
  it('returns a 64-char hex tx_signature', async () => {
    const { tx_signature } = await stubRemitToTreasury(BASE_ARGS);
    expect(tx_signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stubRemitToTreasury — zero-fee sentinel', () => {
  it('returns all-zero sentinel when fee_atomic === 0', async () => {
    const { tx_signature } = await stubRemitToTreasury({ ...BASE_ARGS, fee_atomic: 0 });
    expect(tx_signature).toBe('0'.repeat(64));
  });

  it('does NOT return zero sentinel for non-zero fee', async () => {
    const { tx_signature } = await stubRemitToTreasury(BASE_ARGS);
    expect(tx_signature).not.toBe('0'.repeat(64));
  });
});

describe('stubRemitToTreasury — determinism', () => {
  it('identical args produce identical tx_signature', async () => {
    const r1 = await stubRemitToTreasury(BASE_ARGS);
    const r2 = await stubRemitToTreasury(BASE_ARGS);
    expect(r1.tx_signature).toBe(r2.tx_signature);
  });

  it('different fee_atomic → different tx_signature', async () => {
    const r1 = await stubRemitToTreasury({ ...BASE_ARGS, fee_atomic: 10_000 });
    const r2 = await stubRemitToTreasury({ ...BASE_ARGS, fee_atomic: 20_000 });
    expect(r1.tx_signature).not.toBe(r2.tx_signature);
  });

  it('different source → different tx_signature', async () => {
    const r1 = await stubRemitToTreasury({ ...BASE_ARGS, source: 'onramp' });
    const r2 = await stubRemitToTreasury({ ...BASE_ARGS, source: 'offramp' });
    expect(r1.tx_signature).not.toBe(r2.tx_signature);
  });

  it('different correlation_id → different tx_signature', async () => {
    const r1 = await stubRemitToTreasury({ ...BASE_ARGS, correlation_id: 'corr-001' });
    const r2 = await stubRemitToTreasury({ ...BASE_ARGS, correlation_id: 'corr-002' });
    expect(r1.tx_signature).not.toBe(r2.tx_signature);
  });
});
