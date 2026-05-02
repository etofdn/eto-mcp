/**
 * Tests for Open Savings BPP handler (FN-121 / T-3.11.2.2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  openSavings,
  stubs,
  OpenSavingsRejected,
  type OpenSavingsRequest,
  type OpenSavingsDeps,
} from './open-savings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBJECT = 'a'.repeat(64);
const CHECKING_PDA = 'b'.repeat(64);
const ISSUER = 'c'.repeat(64);

function makeRequest(overrides: Partial<OpenSavingsRequest> = {}): OpenSavingsRequest {
  return {
    subject: SUBJECT,
    linked_checking_account_pda: CHECKING_PDA,
    bank_issuer: ISSUER,
    opened_slot: 1000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpenSavingsDeps> = {}): OpenSavingsDeps {
  return {
    verifyCheckingCredential: vi.fn().mockResolvedValue(true),
    issueSavingsCredential: vi.fn().mockResolvedValue({ tx_signature: 'sig'.repeat(21).slice(0, 64), credential_pda: 'd'.repeat(64) }),
    recordSavingsAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('openSavings — happy path', () => {
  it('returns a valid PDA, credential, and fulfillment_uri', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);

    expect(result.savings_account_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fulfillment_uri).toBe(`eto://savings/${result.savings_account_pda}`);
    expect(result.credential.schema).toBe('account.savings.v1');
    expect(result.credential.subject).toBe(SUBJECT);
    expect(result.credential.issuer).toBe(ISSUER);
  });

  it('credential.body has all required fields', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest({ apy_bps: 500, min_balance: 100, tier: 'premium' }), deps);
    const body = result.credential.body;

    expect(body.account_pda).toBe(result.savings_account_pda);
    expect(body.holder).toBe(SUBJECT);
    expect(body.opened_slot).toBe(1000);
    expect(body.currency).toBe('eUSD');
    expect(body.min_balance).toBe(100);
    expect(body.apy_bps).toBe(500);
    expect(body.tier).toBe('premium');
  });

  it('calls recordSavingsAccount and issueSavingsCredential', async () => {
    const deps = makeDeps();
    await openSavings(makeRequest(), deps);

    expect(deps.recordSavingsAccount).toHaveBeenCalledOnce();
    expect(deps.issueSavingsCredential).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('openSavings — defaults', () => {
  it('defaults tier to standard', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);
    expect(result.credential.body.tier).toBe('standard');
  });

  it('defaults apy_bps to 400', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);
    expect(result.credential.body.apy_bps).toBe(400);
  });

  it('defaults min_balance to 0', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);
    expect(result.credential.body.min_balance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Atomicity: no side effects on failure paths
// ---------------------------------------------------------------------------

describe('openSavings — atomicity on failure', () => {
  it('no_checking_credential: does NOT call recordSavingsAccount or issueSavingsCredential', async () => {
    const deps = makeDeps({
      verifyCheckingCredential: vi.fn().mockResolvedValue(false),
    });

    await expect(openSavings(makeRequest(), deps)).rejects.toThrow(OpenSavingsRejected);
    await expect(openSavings(makeRequest(), deps)).rejects.toMatchObject({ reason: 'no_checking_credential' });

    expect(deps.recordSavingsAccount).not.toHaveBeenCalled();
    expect(deps.issueSavingsCredential).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('openSavings — invalid_pda', () => {
  it('throws invalid_pda for short subject', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ subject: 'tooshort' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pda' });
  });

  it('throws invalid_pda for non-hex subject', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ subject: 'z'.repeat(64) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pda' });
  });

  it('throws invalid_pda for short linked_checking_account_pda', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ linked_checking_account_pda: 'abc' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pda' });
  });

  it('throws invalid_pda for short bank_issuer', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ bank_issuer: '0'.repeat(10) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pda' });
  });
});

describe('openSavings — invalid_tier', () => {
  it('throws invalid_tier for unknown tier value', async () => {
    const deps = makeDeps();
    // Cast to bypass TypeScript — tests runtime guard
    await expect(openSavings(makeRequest({ tier: 'gold' as 'standard' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_tier' });
  });
});

describe('openSavings — invalid_apy', () => {
  it('throws invalid_apy for negative apy_bps', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ apy_bps: -1 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_apy' });
  });

  it('throws invalid_apy for apy_bps > 10_000', async () => {
    const deps = makeDeps();
    await expect(openSavings(makeRequest({ apy_bps: 10_001 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_apy' });
  });

  it('accepts apy_bps = 0 (boundary)', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest({ apy_bps: 0 }), deps);
    expect(result.credential.body.apy_bps).toBe(0);
  });

  it('accepts apy_bps = 10_000 (boundary)', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest({ apy_bps: 10_000 }), deps);
    expect(result.credential.body.apy_bps).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// PDA determinism
// ---------------------------------------------------------------------------

describe('openSavings — PDA derivation', () => {
  it('produces the same PDA for the same (subject, opened_slot)', async () => {
    const req = makeRequest({ opened_slot: 5000 });
    const result1 = await openSavings(req, makeDeps());
    const result2 = await openSavings(req, makeDeps());
    expect(result1.savings_account_pda).toBe(result2.savings_account_pda);
  });

  it('produces different PDAs when opened_slot differs (uniqueness regression)', async () => {
    const result1 = await openSavings(makeRequest({ opened_slot: 1000 }), makeDeps());
    const result2 = await openSavings(makeRequest({ opened_slot: 1001 }), makeDeps());
    expect(result1.savings_account_pda).not.toBe(result2.savings_account_pda);
  });

  it('produces different PDAs when subject differs', async () => {
    const result1 = await openSavings(makeRequest({ subject: 'a'.repeat(64) }), makeDeps());
    const result2 = await openSavings(makeRequest({ subject: '1'.repeat(64) }), makeDeps());
    expect(result1.savings_account_pda).not.toBe(result2.savings_account_pda);
  });
});

// ---------------------------------------------------------------------------
// Credential schema field coverage
// ---------------------------------------------------------------------------

describe('openSavings — credential schema fields', () => {
  it('credential body contains all required account-savings.json fields', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);
    const body = result.credential.body;

    // All fields from spec/banking/credentials/account-savings.json
    expect(body).toHaveProperty('account_pda');
    expect(body).toHaveProperty('holder');
    expect(body).toHaveProperty('opened_slot');
    expect(body).toHaveProperty('currency');
    expect(body).toHaveProperty('min_balance');
    expect(body).toHaveProperty('apy_bps');
    expect(body).toHaveProperty('tier');

    // Type checks
    expect(typeof body.account_pda).toBe('string');
    expect(typeof body.holder).toBe('string');
    expect(typeof body.opened_slot).toBe('number');
    expect(body.currency).toBe('eUSD');
    expect(typeof body.min_balance).toBe('number');
    expect(typeof body.apy_bps).toBe('number');
    expect(['standard', 'premium', 'private']).toContain(body.tier);
  });

  it('credential top-level has schema, subject, issuer, body', async () => {
    const deps = makeDeps();
    const result = await openSavings(makeRequest(), deps);

    expect(result.credential).toHaveProperty('schema');
    expect(result.credential).toHaveProperty('subject');
    expect(result.credential).toHaveProperty('issuer');
    expect(result.credential).toHaveProperty('body');
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke test
// ---------------------------------------------------------------------------

describe('stubs', () => {
  it('verifyCheckingCredential returns true', async () => {
    expect(await stubs.verifyCheckingCredential(SUBJECT, CHECKING_PDA)).toBe(true);
  });

  it('issueSavingsCredential returns tx_signature of length 64', async () => {
    const cred: Parameters<typeof stubs.issueSavingsCredential>[0] = {
      schema: 'account.savings.v1',
      subject: SUBJECT,
      issuer: ISSUER,
      body: {
        account_pda: '0'.repeat(64),
        holder: SUBJECT,
        opened_slot: 0,
        currency: 'eUSD',
        min_balance: 0,
        apy_bps: 400,
        tier: 'standard',
      },
    };
    const { tx_signature, credential_pda } = await stubs.issueSavingsCredential(cred);
    expect(tx_signature).toHaveLength(64);
    expect(credential_pda).toHaveLength(64);
  });

  it('recordSavingsAccount resolves without throwing', async () => {
    await expect(stubs.recordSavingsAccount('0'.repeat(64), {
      holder: SUBJECT,
      opened_slot: 0,
      min_balance: 0,
      apy_bps: 400,
      tier: 'standard',
    })).resolves.toBeUndefined();
  });
});
