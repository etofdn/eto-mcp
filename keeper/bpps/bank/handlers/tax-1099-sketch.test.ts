/**
 * Tests for the Tax 1099 BPP sketch handler (FN-087 / FN-132).
 *
 * The handler is a v0 sketch — no idempotency store, no real signing,
 * no monetary totals. Tests below assert the behaviour the sketch
 * actually has and leave `test.todo(...)` markers for the gaps that
 * follow-up tasks (FN-023 / FN-034 / FN-117 / FN-118 / idempotency)
 * are tracking.
 *
 * Test runner: vitest (matching `offramp.test.ts` / `wire.test.ts`).
 */

import { createHash } from 'node:crypto';

import { describe, it, test, expect, vi } from 'vitest';

import {
  runTax1099Sketch,
  buildTax1099Vc,
  tax1099SchemaIdHex,
  Tax1099SketchError,
  defaultFirstSlotOfYear,
  DEFAULT_SLOTS_PER_YEAR,
} from './tax-1099-sketch.js';
import type {
  Tax1099SketchDeps,
  Tax1099SketchRequest,
  Tax1099VcEnvelope,
} from './tax-1099-sketch.js';

import { jcsCanonicalize } from '../../../../src/issuers/bank-mock.js';
import type { AuditFeedJsonLd } from '../../../../src/services/indexer/audit-trail.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTHORITY = 'AgntCard1111111111111111111111111111111111';
const ISSUER_AUTH = 'IssuerAuth111111111111111111111111111111111';
const NETWORK = 'NetworkAuth11111111111111111111111111111111';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeFeed(
  authority: string,
  opts: { kytCount?: number; revocationCount?: number } = {},
): AuditFeedJsonLd {
  const kytCount = opts.kytCount ?? 3;
  const revocationCount = opts.revocationCount ?? 0;
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://schema.eto.network/audit/v1',
    ],
    id: `urn:eto:audit:${authority}`,
    type: ['VerifiableCredential', 'AuditTrailFeed'],
    issuer: 'did:eto:indexer:audit-trail:v0',
    issuanceDate: '2025-01-01T00:00:00.000Z',
    credentialSubject: {
      id: `did:eto:agentcard:${authority}`,
      authority,
      bounds: { sinceSlot: 0, untilSlot: 1_000_000 },
      events: [
        {
          kind: 'kyt',
          stage: 'init',
          txSignature: 'sig1',
          slot: 100,
          timestamp: '2025-02-01T00:00:00Z',
          counterparty: { party: 'bpp', authority: 'cp1', credPointers: [] },
          selfCredPointers: [],
        },
      ],
      summary: {
        kytCount,
        initCount: kytCount,
        confirmCount: 0,
        rateCount: 0,
        revocationCount,
      },
    },
  };
}

function makeRequest(
  overrides: Partial<Tax1099SketchRequest> = {},
): Tax1099SketchRequest {
  return {
    agentCardAuthority: AUTHORITY,
    taxYear: 2025,
    jurisdiction: 'US',
    issuerAuthorityPubkey: ISSUER_AUTH,
    networkPubkey: NETWORK,
    ...overrides,
  };
}

interface CallLog {
  events: Array<'pin' | 'issue'>;
  pinArgs: string[];
  issueArgs: Array<Record<string, unknown>>;
}

function makeDeps(
  overrides: Partial<Tax1099SketchDeps> = {},
  log?: CallLog,
): Tax1099SketchDeps {
  const buildAuditFeed = vi.fn(async (authority: string) =>
    makeFeed(authority),
  );
  const indexer = { buildAuditFeed } as unknown as Tax1099SketchDeps['indexer'];

  const pinner: Tax1099SketchDeps['pinner'] = {
    pin: vi.fn(async (jcs: string) => {
      log?.events.push('pin');
      log?.pinArgs.push(jcs);
      return { uri: `ipfs://${sha256Hex(jcs).slice(0, 16)}` };
    }),
  };

  const chain: Tax1099SketchDeps['chain'] = {
    issueCredential: vi.fn(async (input) => {
      log?.events.push('issue');
      log?.issueArgs.push({ ...input });
      return {
        credentialPda: 'CredPda1111111111111111111111111111111111',
        txSignature: 's'.repeat(64),
      };
    }),
  };

  const clock: Tax1099SketchDeps['clock'] = {
    currentSlot: vi.fn(async () => 1n),
  };

  return {
    indexer,
    chain,
    pinner,
    clock,
    nowUnix: () => 1_700_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runTax1099Sketch — happy path', () => {
  it('returns a Tax1099SketchResponse with the expected shape', async () => {
    const log: CallLog = { events: [], pinArgs: [], issueArgs: [] };
    const deps = makeDeps({}, log);
    const req = makeRequest();

    const res = await runTax1099Sketch(deps, req);

    expect(res.status).toBe('issued');
    expect(res.credentialPda).toMatch(/^CredPda/);
    expect(res.txSignature).toHaveLength(64);
    expect(res.claimUri).toMatch(/^ipfs:\/\//);
    expect(res.claimHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(res.schemaIdHex).toBe(tax1099SchemaIdHex('US', 2025));

    // VC matches buildTax1099Vc shape
    expect(res.vc.type).toEqual(['VerifiableCredential', 'Tax1099Credential']);
    expect(res.vc.issuer).toBe('did:eto:bank:eto-reference');
    expect(res.vc.credentialSubject.taxYear).toBe(2025);
    expect(res.vc.credentialSubject.jurisdiction).toBe('US');
    expect(res.vc.credentialSubject.id).toBe(
      `did:eto:agentcard:${AUTHORITY}`,
    );
    expect(res.vc.evidence[0].type).toBe('EtoChainEventDigest');
    expect(res.vc.proof?.proofValue).toBe('<unsigned-v0>');
  });

  it('claim_hash equals sha256(JCS(envelope without proof))', async () => {
    const log: CallLog = { events: [], pinArgs: [], issueArgs: [] };
    const deps = makeDeps({}, log);
    const res = await runTax1099Sketch(deps, makeRequest());

    const { proof, ...withoutProof } = res.vc as Tax1099VcEnvelope & {
      proof?: unknown;
    };
    void proof;
    const expected = sha256Hex(jcsCanonicalize(withoutProof));
    expect(res.claimHashHex).toBe(expected);

    // The bytes pinned are the JCS bytes (without proof) — same string the
    // hash was taken over.
    expect(log.pinArgs[0]).toBe(jcsCanonicalize(withoutProof));
  });

  it('forwards schemaIdHex and claim_hash into IssueCredential call', async () => {
    const log: CallLog = { events: [], pinArgs: [], issueArgs: [] };
    const deps = makeDeps({}, log);
    const res = await runTax1099Sketch(deps, makeRequest());

    expect(log.issueArgs).toHaveLength(1);
    const issueArg = log.issueArgs[0]!;
    expect(issueArg.schemaIdHex).toBe(res.schemaIdHex);
    expect(issueArg.claimHashHex).toBe(res.claimHashHex);
    expect(issueArg.subjectAgentCardPubkey).toBe(AUTHORITY);
    expect(issueArg.validUntilSlot).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Schema-id rule
// ---------------------------------------------------------------------------

describe('tax1099SchemaIdHex — schema-id rule', () => {
  it('hashes "eto.beckn.schema.tax.1099.us.2025.v1" for US/2025', () => {
    const expected = sha256Hex('eto.beckn.schema.tax.1099.us.2025.v1');
    expect(tax1099SchemaIdHex('US', 2025)).toBe(expected);
    expect(tax1099SchemaIdHex('US', 2025)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes "eto.beckn.schema.tax.1099.gb.2024.v1" for GB/2024', () => {
    const expected = sha256Hex('eto.beckn.schema.tax.1099.gb.2024.v1');
    expect(tax1099SchemaIdHex('GB', 2024)).toBe(expected);
  });

  it('normalises uppercase jurisdiction to lowercase before hashing', () => {
    expect(tax1099SchemaIdHex('US', 2025)).toBe(
      tax1099SchemaIdHex('us', 2025),
    );
    expect(tax1099SchemaIdHex('Gb', 2024)).toBe(
      tax1099SchemaIdHex('gb', 2024),
    );
  });

  it('different (jurisdiction, year) pairs hash to different ids', () => {
    expect(tax1099SchemaIdHex('US', 2025)).not.toBe(
      tax1099SchemaIdHex('US', 2024),
    );
    expect(tax1099SchemaIdHex('US', 2025)).not.toBe(
      tax1099SchemaIdHex('GB', 2025),
    );
  });
});

// ---------------------------------------------------------------------------
// JCS hash stability
// ---------------------------------------------------------------------------

describe('runTax1099Sketch — JCS hash stability', () => {
  it('identical inputs (and pinned now) produce identical claim_hash', async () => {
    const deps1 = makeDeps();
    const deps2 = makeDeps();
    const req = makeRequest();

    const r1 = await runTax1099Sketch(deps1, req);
    const r2 = await runTax1099Sketch(deps2, req);

    expect(r1.claimHashHex).toBe(r2.claimHashHex);
  });

  it('mutating proof.proofValue does NOT change the hashed bytes', async () => {
    // Build a VC and hash it without the proof — the placeholder
    // `<unsigned-v0>` MUST be excluded.
    const vc = buildTax1099Vc({
      agentCardAuthority: AUTHORITY,
      taxYear: 2025,
      jurisdiction: 'US',
      currency: 'USD',
      formVariant: '1099-MISC',
      totals: {
        totalIncome: '0.00',
        totalFees: '0.00',
        totalInterestPaid: '0.00',
        totalWithholding: '0.00',
        transactionCount: 0,
        digestRootBase58: '1111',
      },
      issuerAuthorityPubkey: ISSUER_AUTH,
      networkPubkey: NETWORK,
      nowUnix: 1_700_000_000,
    });

    const stripProof = (v: Tax1099VcEnvelope) => {
      const { proof, ...rest } = v as Tax1099VcEnvelope & { proof?: unknown };
      void proof;
      return rest;
    };

    const baseHash = sha256Hex(jcsCanonicalize(stripProof(vc)));

    const mutated = {
      ...vc,
      proof: { ...vc.proof!, proofValue: 'OTHER-PLACEHOLDER-VALUE' },
    } as Tax1099VcEnvelope;
    const mutatedHash = sha256Hex(jcsCanonicalize(stripProof(mutated)));

    expect(mutatedHash).toBe(baseHash);
  });
});

// ---------------------------------------------------------------------------
// Error paths — every Tax1099SketchErrorKind discriminant is exercised.
// ---------------------------------------------------------------------------

describe('runTax1099Sketch — invalid_request', () => {
  it('rejects empty agentCardAuthority', async () => {
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ agentCardAuthority: '' })),
    ).rejects.toThrow(Tax1099SketchError);
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ agentCardAuthority: '' })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'empty_authority' });
  });

  it('rejects taxYear < 2024', async () => {
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ taxYear: 2023 })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_tax_year' });
  });

  it('rejects non-integer taxYear', async () => {
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ taxYear: 2025.5 })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_tax_year' });
  });

  it('rejects malformed jurisdiction (length / case)', async () => {
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ jurisdiction: 'USA' })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_jurisdiction' });
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ jurisdiction: 'us' })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_jurisdiction' });
  });

  it('rejects malformed currency', async () => {
    await expect(
      runTax1099Sketch(makeDeps(), makeRequest({ currency: 'usd' })),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_currency' });
  });

  it('rejects unknown formVariant', async () => {
    await expect(
      runTax1099Sketch(
        makeDeps(),
        // @ts-expect-error - intentionally bad value
        makeRequest({ formVariant: '1099-XX' }),
      ),
    ).rejects.toMatchObject({ kind: 'invalid_request', reason: 'invalid_form_variant' });
  });
});

describe('runTax1099Sketch — no_activity', () => {
  it('throws when both kytCount and revocationCount are 0', async () => {
    const deps = makeDeps({
      indexer: {
        buildAuditFeed: vi.fn(async (authority: string) =>
          makeFeed(authority, { kytCount: 0, revocationCount: 0 }),
        ),
      } as unknown as Tax1099SketchDeps['indexer'],
    });

    await expect(runTax1099Sketch(deps, makeRequest())).rejects.toMatchObject({
      kind: 'no_activity',
    });
  });
});

describe('runTax1099Sketch — indexer_failed', () => {
  it('wraps an indexer throw with kind=indexer_failed', async () => {
    const deps = makeDeps({
      indexer: {
        buildAuditFeed: vi.fn(async () => {
          throw new Error('indexer unreachable');
        }),
      } as unknown as Tax1099SketchDeps['indexer'],
    });

    await expect(runTax1099Sketch(deps, makeRequest())).rejects.toMatchObject({
      kind: 'indexer_failed',
    });
  });
});

describe('runTax1099Sketch — pin_failed', () => {
  it('wraps a pinner throw with kind=pin_failed', async () => {
    const deps = makeDeps({
      pinner: {
        pin: vi.fn(async () => {
          throw new Error('ipfs offline');
        }),
      },
    });

    await expect(runTax1099Sketch(deps, makeRequest())).rejects.toMatchObject({
      kind: 'pin_failed',
    });
  });

  it('does NOT call IssueCredential when pinning fails', async () => {
    const issue = vi.fn();
    const deps = makeDeps({
      pinner: {
        pin: vi.fn(async () => {
          throw new Error('pin down');
        }),
      },
      chain: { issueCredential: issue } as unknown as Tax1099SketchDeps['chain'],
    });

    await expect(runTax1099Sketch(deps, makeRequest())).rejects.toThrow(
      Tax1099SketchError,
    );
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('runTax1099Sketch — chain_failed', () => {
  it('wraps an IssueCredential throw with kind=chain_failed', async () => {
    const deps = makeDeps({
      chain: {
        issueCredential: vi.fn(async () => {
          throw new Error('rpc timeout');
        }),
      } as unknown as Tax1099SketchDeps['chain'],
    });

    await expect(runTax1099Sketch(deps, makeRequest())).rejects.toMatchObject({
      kind: 'chain_failed',
    });
  });
});

// ---------------------------------------------------------------------------
// Pinner / issuer call ordering — issuance MUST happen AFTER the JCS bytes
// have been pinned (charter: "issuance after settlement-equivalent step").
// ---------------------------------------------------------------------------

describe('runTax1099Sketch — pinner / issuer ordering', () => {
  it('VcPinner.pin is called before IssueCredentialClient.issueCredential', async () => {
    const log: CallLog = { events: [], pinArgs: [], issueArgs: [] };
    const deps = makeDeps({}, log);
    await runTax1099Sketch(deps, makeRequest());

    expect(log.events).toEqual(['pin', 'issue']);
  });

  it('the JCS bytes pinned match the bytes used for claim_hash', async () => {
    const log: CallLog = { events: [], pinArgs: [], issueArgs: [] };
    const deps = makeDeps({}, log);
    const res = await runTax1099Sketch(deps, makeRequest());

    expect(log.pinArgs).toHaveLength(1);
    expect(sha256Hex(log.pinArgs[0]!)).toBe(res.claimHashHex);
  });
});

// ---------------------------------------------------------------------------
// Slot-window stub smoke test
// ---------------------------------------------------------------------------

describe('defaultFirstSlotOfYear', () => {
  it('maps year 2024 to slot 0', () => {
    expect(defaultFirstSlotOfYear(2024)).toBe(0n);
  });

  it('maps year 2025 to one full year of slots', () => {
    expect(defaultFirstSlotOfYear(2025)).toBe(DEFAULT_SLOTS_PER_YEAR);
  });
});

// ---------------------------------------------------------------------------
// v0 gaps — explicit todos so the charter requirement is visible in the
// test report rather than silently passing on missing behaviour.
// ---------------------------------------------------------------------------

describe('runTax1099Sketch — v0 gaps (tracked elsewhere)', () => {
  // No idempotency store in v0. Every call issues a fresh credential.
  // Once the dedupe store lands, this test should assert that a second
  // call with the same (authority, jurisdiction, taxYear) returns
  // `status: "idempotent"` and does NOT re-invoke `issueCredential`.
  test.todo(
    'dedupe on (authority, jurisdiction, taxYear) — once idempotency store lands (FN-132 follow-up)',
  );

  // proof.proofValue is the placeholder `"<unsigned-v0>"`. Real
  // Ed25519Signature2020 signing is a follow-up task.
  test.todo('real Ed25519 signing of proof.proofValue (FN-132 follow-up)');

  // Monetary totals are always "0.00" until FN-117 / FN-118 wire ledger
  // amounts into the KYT event stream.
  test.todo(
    'non-zero monetary totals (totalIncome / totalFees / etc.) — blocked on FN-117 / FN-118',
  );

  // Caller-auth binding: the request type currently does not carry a
  // verified principal, so the handler trusts `agentCardAuthority` from
  // the request body. A `caller_auth_mismatch` discriminant should be
  // added once the gateway propagates the verified caller identity.
  // Tracked under FN-023 / FN-034.
  test.todo(
    'caller_auth_mismatch when verified caller != request.agentCardAuthority (FN-023 / FN-034)',
  );
});
