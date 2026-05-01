/**
 * Tests for Open Checking BPP handler (FN-115 / T-3.11.1.2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  openChecking,
  stubs,
  OpenCheckingRejected,
  REQUIRED_SCHEMAS,
  type OpenCheckingRequest,
  type OpenCheckingDeps,
} from './open-checking.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBJECT = 'a'.repeat(64);
const ISSUER = 'c'.repeat(64);

function makeRequest(overrides: Partial<OpenCheckingRequest> = {}): OpenCheckingRequest {
  return {
    subject: SUBJECT,
    bank_issuer: ISSUER,
    opened_slot: 1000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpenCheckingDeps> = {}): OpenCheckingDeps {
  return {
    verifyHolderCredentials: vi.fn().mockResolvedValue(true),
    issueCheckingCredential: vi.fn().mockResolvedValue({ tx_signature: 'sig'.repeat(21).slice(0, 64), credential_pda: 'd'.repeat(64) }),
    recordCheckingAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('openChecking — happy path', () => {
  it('returns a valid PDA, credential, and fulfillment_uri', async () => {
    const deps = makeDeps();
    const result = await openChecking(makeRequest(), deps);

    expect(result.checking_account_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fulfillment_uri).toBe(`eto://checking/${result.checking_account_pda}`);
    expect(result.credential.schema).toBe('account.checking.v1');
    expect(result.credential.subject).toBe(SUBJECT);
    expect(result.credential.issuer).toBe(ISSUER);
  });

  it('calls recordCheckingAccount and issueCheckingCredential', async () => {
    const deps = makeDeps();
    await openChecking(makeRequest(), deps);

    expect(deps.recordCheckingAccount).toHaveBeenCalledOnce();
    expect(deps.issueCheckingCredential).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('openChecking — defaults', () => {
  it('defaults opening_deposit_atomic to 0 when omitted', async () => {
    const deps = makeDeps();
    const result = await openChecking(makeRequest(), deps);
    expect(result.credential.body.opening_balance).toBe(0);
  });

  it('propagates custom opening deposit into credential.body.opening_balance', async () => {
    const deps = makeDeps();
    const result = await openChecking(makeRequest({ opening_deposit_atomic: 500_000 }), deps);
    expect(result.credential.body.opening_balance).toBe(500_000);
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('openChecking — invalid_pubkey', () => {
  it('throws invalid_pubkey for short subject', async () => {
    const deps = makeDeps();
    await expect(openChecking(makeRequest({ subject: 'tooshort' }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for non-hex subject', async () => {
    const deps = makeDeps();
    await expect(openChecking(makeRequest({ subject: 'z'.repeat(64) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });

  it('throws invalid_pubkey for invalid bank_issuer', async () => {
    const deps = makeDeps();
    await expect(openChecking(makeRequest({ bank_issuer: '0'.repeat(10) }), deps))
      .rejects.toMatchObject({ reason: 'invalid_pubkey' });
  });
});

describe('openChecking — invalid_deposit', () => {
  it('throws invalid_deposit for negative opening_deposit_atomic', async () => {
    const deps = makeDeps();
    await expect(openChecking(makeRequest({ opening_deposit_atomic: -1 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_deposit' });
  });

  it('throws invalid_deposit for non-integer opening_deposit_atomic', async () => {
    const deps = makeDeps();
    await expect(openChecking(makeRequest({ opening_deposit_atomic: 1.5 }), deps))
      .rejects.toMatchObject({ reason: 'invalid_deposit' });
  });
});

// ---------------------------------------------------------------------------
// Credential gate
// ---------------------------------------------------------------------------

describe('openChecking — credentials_missing', () => {
  it('throws credentials_missing when verifyHolderCredentials returns false', async () => {
    const deps = makeDeps({
      verifyHolderCredentials: vi.fn().mockResolvedValue(false),
    });

    await expect(openChecking(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'credentials_missing' });
  });

  it('does NOT call recordCheckingAccount or issueCheckingCredential when credentials missing', async () => {
    const deps = makeDeps({
      verifyHolderCredentials: vi.fn().mockResolvedValue(false),
    });

    await expect(openChecking(makeRequest(), deps)).rejects.toThrow(OpenCheckingRejected);

    expect(deps.recordCheckingAccount).not.toHaveBeenCalled();
    expect(deps.issueCheckingCredential).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Atomicity on side-effect failures
// ---------------------------------------------------------------------------

describe('openChecking — ledger_failed', () => {
  it('throws ledger_failed when recordCheckingAccount rejects', async () => {
    const deps = makeDeps({
      recordCheckingAccount: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(openChecking(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'ledger_failed' });
  });

  it('does NOT call issueCheckingCredential when ledger fails', async () => {
    const deps = makeDeps({
      recordCheckingAccount: vi.fn().mockRejectedValue(new Error('db down')),
    });

    await expect(openChecking(makeRequest(), deps)).rejects.toThrow(OpenCheckingRejected);

    expect(deps.issueCheckingCredential).not.toHaveBeenCalled();
  });
});

describe('openChecking — issue_failed', () => {
  it('throws issue_failed when issueCheckingCredential rejects', async () => {
    const deps = makeDeps({
      issueCheckingCredential: vi.fn().mockRejectedValue(new Error('chain unavailable')),
    });

    await expect(openChecking(makeRequest(), deps))
      .rejects.toMatchObject({ reason: 'issue_failed' });
  });
});

// ---------------------------------------------------------------------------
// PDA determinism
// ---------------------------------------------------------------------------

describe('openChecking — PDA derivation', () => {
  it('produces the same PDA for the same (subject, opened_slot)', async () => {
    const req = makeRequest({ opened_slot: 5000 });
    const result1 = await openChecking(req, makeDeps());
    const result2 = await openChecking(req, makeDeps());
    expect(result1.checking_account_pda).toBe(result2.checking_account_pda);
  });

  it('produces different PDAs when opened_slot differs (uniqueness regression)', async () => {
    const result1 = await openChecking(makeRequest({ opened_slot: 1000 }), makeDeps());
    const result2 = await openChecking(makeRequest({ opened_slot: 1001 }), makeDeps());
    expect(result1.checking_account_pda).not.toBe(result2.checking_account_pda);
  });
});

// ---------------------------------------------------------------------------
// Credential schema field coverage
// ---------------------------------------------------------------------------

describe('openChecking — credential schema fields', () => {
  it('credential body contains all 5 required account-checking fields', async () => {
    const deps = makeDeps();
    const result = await openChecking(makeRequest({ opening_deposit_atomic: 1_000_000 }), deps);
    const body = result.credential.body;

    // All 5 fields from spec/banking/credentials/account-checking schema
    expect(body).toHaveProperty('account_pda');
    expect(body).toHaveProperty('holder');
    expect(body).toHaveProperty('opened_slot');
    expect(body).toHaveProperty('currency');
    expect(body).toHaveProperty('opening_balance');

    // Type and value checks
    expect(typeof body.account_pda).toBe('string');
    expect(body.account_pda).toMatch(/^[0-9a-f]{64}$/);
    expect(body.holder).toBe(SUBJECT);
    expect(body.opened_slot).toBe(1000);
    expect(body.currency).toBe('eUSD');
    expect(body.opening_balance).toBe(1_000_000);
  });

  it('credential top-level has schema, subject, issuer, body', async () => {
    const deps = makeDeps();
    const result = await openChecking(makeRequest(), deps);

    expect(result.credential).toHaveProperty('schema');
    expect(result.credential).toHaveProperty('subject');
    expect(result.credential).toHaveProperty('issuer');
    expect(result.credential).toHaveProperty('body');
  });
});

// ---------------------------------------------------------------------------
// REQUIRED_SCHEMAS matches on-chain Network policy
// ---------------------------------------------------------------------------

describe('openChecking — REQUIRED_SCHEMAS', () => {
  it('REQUIRED_SCHEMAS includes verified-human and kyc.us-test schemas', () => {
    expect(REQUIRED_SCHEMAS).toContain('eto.beckn.schema.verified-human.v1');
    expect(REQUIRED_SCHEMAS).toContain('eto.beckn.schema.kyc.us-test.v1');
    expect(REQUIRED_SCHEMAS).toHaveLength(2);
  });

  it('passes REQUIRED_SCHEMAS to verifyHolderCredentials', async () => {
    const deps = makeDeps();
    await openChecking(makeRequest(), deps);
    expect(deps.verifyHolderCredentials).toHaveBeenCalledWith(SUBJECT, REQUIRED_SCHEMAS);
  });
});

// ---------------------------------------------------------------------------
// Stubs smoke tests
// ---------------------------------------------------------------------------

describe('stubs', () => {
  it('verifyHolderCredentials returns true', async () => {
    expect(await stubs.verifyHolderCredentials(SUBJECT, REQUIRED_SCHEMAS)).toBe(true);
  });

  it('issueCheckingCredential returns tx_signature of length 64 and credential_pda of length 64', async () => {
    const cred: Parameters<typeof stubs.issueCheckingCredential>[0] = {
      schema: 'account.checking.v1',
      subject: SUBJECT,
      issuer: ISSUER,
      body: {
        account_pda: '0'.repeat(64),
        holder: SUBJECT,
        opened_slot: 0,
        currency: 'eUSD',
        opening_balance: 0,
      },
    };
    const { tx_signature, credential_pda } = await stubs.issueCheckingCredential(cred);
    expect(tx_signature).toHaveLength(64);
    expect(credential_pda).toHaveLength(64);
  });

  it('recordCheckingAccount resolves without throwing', async () => {
    await expect(stubs.recordCheckingAccount('0'.repeat(64), {
      holder: SUBJECT,
      opened_slot: 0,
      opening_balance: 0,
    })).resolves.toBeUndefined();
  });
});
