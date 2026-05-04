/**
 * Tests for Wire Transfer BPP handler (FN-119 / T-3.11.1.6).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeWire,
  stubs,
  WireRejected,
  type WireRequest,
  type WireDeps,
} from './wire.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOLDER = 'a'.repeat(64);
const CHECKING_PDA = 'b'.repeat(64);

const DOMESTIC_RECIPIENT = {
  routing_number: '021000021',
  account_number: '123456789',
  name: 'Alice Domestic',
};

const INTL_RECIPIENT = {
  swift_bic: 'DEUTDEDB',
  iban: 'DE89370400440532013000',
  name: 'Bob International',
};

function makeRequest(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    caller_pubkey: HOLDER, // FN-034: caller MUST equal holder
    holder: HOLDER,
    checking_account_pda: CHECKING_PDA,
    amount: 10_000_000,  // 10 eUSD
    recipient: DOMESTIC_RECIPIENT,
    kind: 'domestic',
    initiated_slot: 5000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WireDeps> = {}): WireDeps {
  return {
    feeFor: vi.fn().mockImplementation((kind: string) => kind === 'domestic' ? 5_000_000 : 25_000_000),
    lockEscrow: vi.fn().mockResolvedValue({ tx_signature: 's'.repeat(64) }),
    releaseEscrow: vi.fn().mockResolvedValue({ external_ref: 'extref123', confirmed_at_slot: 6000 }),
    refundEscrow: vi.fn().mockResolvedValue({ tx_signature: 'r'.repeat(64) }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path — domestic
// ---------------------------------------------------------------------------

describe('executeWire — happy path domestic', () => {
  it('returns phase released with correct fields', async () => {
    const deps = makeDeps();
    const result = await executeWire(makeRequest(), deps);

    expect(result.phase).toBe('released');
    expect(result.amount).toBe(10_000_000);
    expect(result.fee).toBe(5_000_000);
    expect(result.wire_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fulfillment_uri).toBe(`eto://wire/${result.wire_id}`);
    expect(result.receipt).toBeDefined();
    expect(result.receipt?.confirmed_at_slot).toBe(6000);
    expect(result.receipt?.external_ref).toBe('extref123');
  });

  it('calls lockEscrow and releaseEscrow exactly once', async () => {
    const deps = makeDeps();
    await executeWire(makeRequest(), deps);

    expect(deps.lockEscrow).toHaveBeenCalledOnce();
    expect(deps.releaseEscrow).toHaveBeenCalledOnce();
    expect(deps.refundEscrow).not.toHaveBeenCalled();
  });

  it('lockEscrow receives correct amount, fee, and wire_id', async () => {
    const deps = makeDeps();
    const result = await executeWire(makeRequest(), deps);

    expect(deps.lockEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        holder: HOLDER,
        checking_pda: CHECKING_PDA,
        amount: 10_000_000,
        fee: 5_000_000,
        wire_id: result.wire_id,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path — international
// ---------------------------------------------------------------------------

describe('executeWire — happy path international', () => {
  it('returns phase released with international fee', async () => {
    const deps = makeDeps();
    const result = await executeWire(
      makeRequest({ kind: 'international', recipient: INTL_RECIPIENT }),
      deps,
    );

    expect(result.phase).toBe('released');
    expect(result.fee).toBe(25_000_000);
  });
});

// ---------------------------------------------------------------------------
// Validation — invalid_pubkey
// ---------------------------------------------------------------------------

describe('executeWire — invalid_pubkey', () => {
  it('throws invalid_pubkey for short holder', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ holder: 'tooshort' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for non-hex holder', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ holder: 'z'.repeat(64) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for short checking_account_pda', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ checking_account_pda: 'abc' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws WireRejected instance', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ holder: 'bad' }), deps))
      .rejects.toBeInstanceOf(WireRejected);
  });
});

// ---------------------------------------------------------------------------
// FN-034 — caller-binding (SECURITY HIGH)
// ---------------------------------------------------------------------------

describe('executeWire — caller-binding (FN-034)', () => {
  it('rejects when caller_pubkey != holder with caller_mismatch', async () => {
    const deps = makeDeps();
    const attacker = 'f'.repeat(64);
    await expect(
      executeWire(makeRequest({ caller_pubkey: attacker }), deps),
    ).rejects.toMatchObject({ reason: 'caller_mismatch' });
  });

  it('rejects without invoking lockEscrow / releaseEscrow / refundEscrow', async () => {
    const deps = makeDeps();
    const attacker = 'f'.repeat(64);
    await expect(
      executeWire(makeRequest({ caller_pubkey: attacker }), deps),
    ).rejects.toBeInstanceOf(WireRejected);
    expect(deps.lockEscrow).not.toHaveBeenCalled();
    expect(deps.releaseEscrow).not.toHaveBeenCalled();
    expect(deps.refundEscrow).not.toHaveBeenCalled();
  });

  it('rejects when caller_pubkey is not a valid hex64 with invalid_pubkey', async () => {
    const deps = makeDeps();
    await expect(
      executeWire(makeRequest({ caller_pubkey: 'tooshort' }), deps),
    ).rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });
});

// ---------------------------------------------------------------------------
// Validation — invalid_amount
// ---------------------------------------------------------------------------

describe('executeWire — invalid_amount', () => {
  it('throws invalid_amount for zero', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ amount: 0 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for negative', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ amount: -1 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('throws invalid_amount for fractional', async () => {
    const deps = makeDeps();
    await expect(executeWire(makeRequest({ amount: 1.5 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_amount' });
  });
});

// ---------------------------------------------------------------------------
// Validation — recipient_invalid
// ---------------------------------------------------------------------------

describe('executeWire — recipient_invalid', () => {
  it('throws recipient_invalid for domestic without routing_number', async () => {
    const deps = makeDeps();
    await expect(
      executeWire(makeRequest({ kind: 'domestic', recipient: { name: 'Alice' } }), deps),
    ).rejects.toMatchObject({ reason: 'recipient_invalid' });
  });

  it('throws recipient_invalid for international without swift_bic', async () => {
    const deps = makeDeps();
    await expect(
      executeWire(makeRequest({ kind: 'international', recipient: { iban: 'DE89...', name: 'Bob' } }), deps),
    ).rejects.toMatchObject({ reason: 'recipient_invalid' });
  });

  it('throws recipient_invalid when name is empty', async () => {
    const deps = makeDeps();
    await expect(
      executeWire(makeRequest({ recipient: { routing_number: '021000021', name: '' } }), deps),
    ).rejects.toMatchObject({ reason: 'recipient_invalid' });
  });
});

// ---------------------------------------------------------------------------
// Lock failure
// ---------------------------------------------------------------------------

describe('executeWire — lock_failed', () => {
  it('throws lock_failed when lockEscrow rejects', async () => {
    const deps = makeDeps({
      lockEscrow: vi.fn().mockRejectedValue(new Error('on-chain error')),
    });

    await expect(executeWire(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'lock_failed' });
  });

  it('does NOT call releaseEscrow when lock fails', async () => {
    const deps = makeDeps({
      lockEscrow: vi.fn().mockRejectedValue(new Error('on-chain error')),
    });

    await expect(executeWire(makeRequest(), deps)).rejects.toThrow(WireRejected);
    expect(deps.releaseEscrow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Release failure → refund path
// ---------------------------------------------------------------------------

describe('executeWire — release_failed', () => {
  it('throws release_failed when releaseEscrow rejects', async () => {
    const deps = makeDeps({
      releaseEscrow: vi.fn().mockRejectedValue(new Error('rail error')),
    });

    await expect(executeWire(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'release_failed' });
  });

  it('calls refundEscrow when release fails', async () => {
    const deps = makeDeps({
      releaseEscrow: vi.fn().mockRejectedValue(new Error('rail error')),
    });

    await expect(executeWire(makeRequest(), deps)).rejects.toThrow(WireRejected);
    expect(deps.refundEscrow).toHaveBeenCalledOnce();
  });

  it('refundEscrow receives correct args on release failure', async () => {
    const deps = makeDeps({
      releaseEscrow: vi.fn().mockRejectedValue(new Error('rail error')),
    });

    let capturedWireId: string | undefined;
    // Override lockEscrow to capture wire_id
    (deps.lockEscrow as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { wire_id: string }) => {
        capturedWireId = args.wire_id;
        return { tx_signature: 's'.repeat(64) };
      }
    );

    await expect(executeWire(makeRequest(), deps)).rejects.toThrow(WireRejected);

    expect(deps.refundEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        wire_id: capturedWireId,
        holder: HOLDER,
        amount: 10_000_000,
        fee: 5_000_000,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism regression
// ---------------------------------------------------------------------------

describe('executeWire — wire_id determinism', () => {
  it('produces the same wire_id for identical inputs', async () => {
    const req = makeRequest({ initiated_slot: 9999 });
    const r1 = await executeWire(req, makeDeps());
    const r2 = await executeWire(req, makeDeps());
    expect(r1.wire_id).toBe(r2.wire_id);
  });

  it('produces different wire_id when amount differs', async () => {
    const r1 = await executeWire(makeRequest({ amount: 10_000_000 }), makeDeps());
    const r2 = await executeWire(makeRequest({ amount: 20_000_000 }), makeDeps());
    expect(r1.wire_id).not.toBe(r2.wire_id);
  });

  it('produces different wire_id when initiated_slot differs', async () => {
    const r1 = await executeWire(makeRequest({ initiated_slot: 1000 }), makeDeps());
    const r2 = await executeWire(makeRequest({ initiated_slot: 1001 }), makeDeps());
    expect(r1.wire_id).not.toBe(r2.wire_id);
  });

  it('produces different wire_id when holder differs', async () => {
    // FN-034: caller_pubkey must equal holder, so override both together.
    const r1 = await executeWire(makeRequest({ caller_pubkey: 'a'.repeat(64), holder: 'a'.repeat(64) }), makeDeps());
    const r2 = await executeWire(makeRequest({ caller_pubkey: '1'.repeat(64), holder: '1'.repeat(64) }), makeDeps());
    expect(r1.wire_id).not.toBe(r2.wire_id);
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke test
// ---------------------------------------------------------------------------

describe('stubs', () => {
  it('feeFor domestic returns 5_000_000', () => {
    expect(stubs.feeFor('domestic', 10_000_000)).toBe(5_000_000);
  });

  it('feeFor international returns 25_000_000', () => {
    expect(stubs.feeFor('international', 10_000_000)).toBe(25_000_000);
  });

  it('lockEscrow returns tx_signature of length 64', async () => {
    const { tx_signature } = await stubs.lockEscrow({
      holder: HOLDER,
      checking_pda: CHECKING_PDA,
      amount: 10_000_000,
      fee: 5_000_000,
      wire_id: '0'.repeat(64),
    });
    expect(tx_signature).toHaveLength(64);
  });

  it('releaseEscrow returns external_ref and confirmed_at_slot', async () => {
    const result = await stubs.releaseEscrow({
      wire_id: '0'.repeat(64),
      recipient: DOMESTIC_RECIPIENT,
      amount: 10_000_000,
    });
    expect(result.external_ref).toHaveLength(16);
    expect(typeof result.confirmed_at_slot).toBe('number');
  });

  it('refundEscrow returns tx_signature of length 64', async () => {
    const { tx_signature } = await stubs.refundEscrow({
      wire_id: '0'.repeat(64),
      holder: HOLDER,
      amount: 10_000_000,
      fee: 5_000_000,
    });
    expect(tx_signature).toHaveLength(64);
  });
});
