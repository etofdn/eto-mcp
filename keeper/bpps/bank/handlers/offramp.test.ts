/**
 * Tests for Offramp BPP handler (FN-108 / T-3.10.2.3, FN-109 / T-3.10.2.4).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeOfframp,
  stubs,
  OfframpRejected,
  type OfframpRequest,
  type OfframpDeps,
} from './offramp.js';
import { BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX } from './fee.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOLDER = 'a'.repeat(64);
const HOLDER_TOKEN_PDA = 'b'.repeat(64);

const DOMESTIC_DEST: OfframpRequest['destination'] = {
  account_holder_name: 'Alice Smith',
  routing_number: '021000021',
  account_number: '123456789',
};

const INTL_DEST: OfframpRequest['destination'] = {
  account_holder_name: 'Bob Jones',
  swift_bic: 'CHASUS33',
  iban: 'DE89370400440532013000',
};

function makeRequest(overrides: Partial<OfframpRequest> = {}): OfframpRequest {
  return {
    holder: HOLDER,
    holder_token_account_pda: HOLDER_TOKEN_PDA,
    eusd_amount_atomic: 100_000_000,
    destination: DOMESTIC_DEST,
    initiated_slot: 5000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OfframpDeps> = {}): OfframpDeps {
  return {
    feeFor: vi.fn((amount: number) => Math.floor(amount / 10_000)),
    burnOnChain: vi.fn().mockResolvedValue({ tx_signature: 'b'.repeat(64) }),
    pushUsd: vi.fn().mockResolvedValue({ external_ref: 'ext_ref_001' }),
    flagReconciliation: vi.fn().mockResolvedValue(undefined),
    remitToTreasury: vi.fn().mockResolvedValue({ tx_signature: 'a'.repeat(64) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('executeOfframp — happy path', () => {
  it('100_000_000 atomic ($100): fee=10000, net=99_990_000, pushed cents=9999', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest(), deps);

    expect(result.phase).toBe('pushed');
    expect(result.burned_atomic).toBe(100_000_000);
    expect(result.fee_atomic).toBe(10_000);          // 1pip of 100_000_000 = 10_000
    expect(result.usd_cents_pushed).toBe(9999);       // floor(99_990_000 / 10_000) = 9999
    expect(result.burn_tx_signature).toBe('b'.repeat(64));
    expect(result.external_ref).toBe('ext_ref_001');
    expect(result.fulfillment_uri).toBe(`eto://offramp/${result.offramp_id}`);
  });

  it('1pip fee math: feeFor(1_000_000) = 100, net = 999_900, cents = 99', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest({ eusd_amount_atomic: 1_000_000 }), deps);

    expect(result.fee_atomic).toBe(100);
    expect(result.usd_cents_pushed).toBe(99);   // floor(999_900 / 10_000) = 99
  });

  it('domestic destination (routing+account) succeeds', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest({ destination: DOMESTIC_DEST }), deps);
    expect(result.phase).toBe('pushed');
  });

  it('international destination (SWIFT) succeeds', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest({ destination: INTL_DEST }), deps);
    expect(result.phase).toBe('pushed');
  });

  it('calls burnOnChain with correct holder_token_pda and full amount', async () => {
    const deps = makeDeps();
    await executeOfframp(makeRequest(), deps);

    expect(deps.burnOnChain).toHaveBeenCalledOnce();
    expect(deps.burnOnChain).toHaveBeenCalledWith({
      holder_token_pda: HOLDER_TOKEN_PDA,
      amount: 100_000_000,
    });
  });

  it('calls pushUsd with net USD cents and destination', async () => {
    const deps = makeDeps();
    await executeOfframp(makeRequest(), deps);

    expect(deps.pushUsd).toHaveBeenCalledOnce();
    expect(deps.pushUsd).toHaveBeenCalledWith(9999, DOMESTIC_DEST);
  });

  it('calls remitToTreasury once after successful push (FN-109)', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest(), deps);

    expect(deps.remitToTreasury).toHaveBeenCalledOnce();
    expect(deps.remitToTreasury).toHaveBeenCalledWith({
      fee_atomic: 10_000,
      treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
      source: 'offramp',
      correlation_id: result.offramp_id,
    });
  });

  it('includes treasury_remit_tx_signature in outcome (FN-109)', async () => {
    const deps = makeDeps();
    const result = await executeOfframp(makeRequest(), deps);
    expect(result.treasury_remit_tx_signature).toBe('a'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('executeOfframp — invalid_pubkey', () => {
  it('throws invalid_pubkey for non-hex holder', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ holder: 'z'.repeat(64) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for short holder', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ holder: 'abc' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for short holder_token_account_pda', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ holder_token_account_pda: '00' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });
});

describe('executeOfframp — invalid_amount', () => {
  it('throws invalid_amount for zero eusd_amount_atomic', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ eusd_amount_atomic: 0 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for negative eusd_amount_atomic', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ eusd_amount_atomic: -1 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for non-integer eusd_amount_atomic', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({ eusd_amount_atomic: 1.5 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount when fee >= amount (fee exceeds amount)', async () => {
    // feeFor always returns 1_000_000, amount is 1_000_000 → net = 0
    const deps = makeDeps({ feeFor: vi.fn(() => 1_000_000) });
    await expect(executeOfframp(makeRequest({ eusd_amount_atomic: 1_000_000 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });
});

describe('executeOfframp — destination_invalid', () => {
  it('throws destination_invalid for empty account_holder_name', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({
      destination: { account_holder_name: '', routing_number: '021000021', account_number: '123' },
    }), deps)).rejects.toMatchObject({ reason: 'destination_invalid' });
  });

  it('throws destination_invalid when neither routing+account nor SWIFT present', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({
      destination: { account_holder_name: 'Alice', iban: 'DE89370400440532013000' },
    }), deps)).rejects.toMatchObject({ reason: 'destination_invalid' });
  });

  it('throws destination_invalid when only routing_number present (missing account_number)', async () => {
    const deps = makeDeps();
    await expect(executeOfframp(makeRequest({
      destination: { account_holder_name: 'Alice', routing_number: '021000021' },
    }), deps)).rejects.toMatchObject({ reason: 'destination_invalid' });
  });
});

// ---------------------------------------------------------------------------
// Atomicity: burn failure — remitToTreasury NOT called
// ---------------------------------------------------------------------------

describe('executeOfframp — burn_failed atomicity', () => {
  it('burn failure throws burn_failed; pushUsd, flagReconciliation, and remitToTreasury NOT called', async () => {
    const deps = makeDeps({
      burnOnChain: vi.fn().mockRejectedValue(new Error('on-chain error')),
    });

    await expect(executeOfframp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'burn_failed' });

    expect(deps.pushUsd).not.toHaveBeenCalled();
    expect(deps.flagReconciliation).not.toHaveBeenCalled();
    expect(deps.remitToTreasury).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Atomicity: push failure post-burn — remitToTreasury NOT called
// ---------------------------------------------------------------------------

describe('executeOfframp — push_failed_post_burn reconciliation', () => {
  it('push failure throws push_failed_post_burn and calls flagReconciliation with correct args', async () => {
    const deps = makeDeps({
      pushUsd: vi.fn().mockRejectedValue(new Error('bank gateway timeout')),
    });

    await expect(executeOfframp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'push_failed_post_burn' });

    expect(deps.flagReconciliation).toHaveBeenCalledOnce();
    const [id, holder, burned] = (deps.flagReconciliation as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toHaveLength(64);   // full sha256 hex
    expect(holder).toBe(HOLDER);
    expect(burned).toBe(100_000_000);
  });

  it('remitToTreasury NOT called when push_failed_post_burn (fee not yet earned)', async () => {
    const deps = makeDeps({
      pushUsd: vi.fn().mockRejectedValue(new Error('push fail')),
    });

    await expect(executeOfframp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'push_failed_post_burn' });

    expect(deps.remitToTreasury).not.toHaveBeenCalled();
  });

  it('burnOnChain IS called before the push fails (burn is committed)', async () => {
    const deps = makeDeps({
      pushUsd: vi.fn().mockRejectedValue(new Error('push fail')),
    });

    await expect(executeOfframp(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'push_failed_post_burn' });

    expect(deps.burnOnChain).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// offramp_id determinism
// ---------------------------------------------------------------------------

describe('executeOfframp — offramp_id determinism', () => {
  it('produces the same offramp_id for identical inputs', async () => {
    const req = makeRequest();
    const r1 = await executeOfframp(req, makeDeps());
    const r2 = await executeOfframp(req, makeDeps());
    expect(r1.offramp_id).toBe(r2.offramp_id);
  });

  it('produces different offramp_id when destination differs', async () => {
    const r1 = await executeOfframp(makeRequest({ destination: DOMESTIC_DEST }), makeDeps());
    const r2 = await executeOfframp(makeRequest({ destination: INTL_DEST }), makeDeps());
    expect(r1.offramp_id).not.toBe(r2.offramp_id);
  });

  it('produces different offramp_id when initiated_slot differs', async () => {
    const r1 = await executeOfframp(makeRequest({ initiated_slot: 1000 }), makeDeps());
    const r2 = await executeOfframp(makeRequest({ initiated_slot: 1001 }), makeDeps());
    expect(r1.offramp_id).not.toBe(r2.offramp_id);
  });

  it('offramp_id is a 64-char hex string', async () => {
    const result = await executeOfframp(makeRequest(), makeDeps());
    expect(result.offramp_id).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke test
// ---------------------------------------------------------------------------

describe('stubs', () => {
  it('feeFor(1_000_000) = 100 (1pip)', () => {
    expect(stubs.feeFor(1_000_000)).toBe(100);
  });

  it('burnOnChain returns tx_signature of length 64', async () => {
    const { tx_signature } = await stubs.burnOnChain({ holder_token_pda: HOLDER_TOKEN_PDA, amount: 1_000_000 });
    expect(tx_signature).toHaveLength(64);
  });

  it('pushUsd returns external_ref of length 16', async () => {
    const { external_ref } = await stubs.pushUsd(100, DOMESTIC_DEST);
    expect(external_ref).toHaveLength(16);
  });

  it('flagReconciliation resolves without throwing', async () => {
    await expect(stubs.flagReconciliation('0'.repeat(64), HOLDER, 1_000_000)).resolves.toBeUndefined();
  });

  it('remitToTreasury returns 64-hex tx_signature', async () => {
    const { tx_signature } = await stubs.remitToTreasury({
      fee_atomic: 10_000,
      treasury_pda_hex: BANK_TREASURY_TOKEN_ACCOUNT_PDA_HEX,
      source: 'offramp',
      correlation_id: '0'.repeat(64),
    });
    expect(tx_signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
