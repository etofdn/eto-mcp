/**
 * Tests for FN-090 — Inbound BPP gateway role.
 *
 * Covers:
 *  - handleConfirmTrigger POSTs to resolved URL with proper Beckn /confirm body
 *  - /on_confirm with order.state=COMPLETED -> submits CompleteTask
 *  - /on_confirm with order.state=CANCELLED -> submits FailTask
 *  - /on_confirm with invalid body -> 400 with errors
 *  - fulfillment_uri extraction from tracking.url and artifacts[0].url fallback
 *
 * FN-036: Gateway ownership hardening
 *  - unknown bpp_id rejected with 403 when expectedBpps is set
 *  - duplicate transaction_id rejected with 409 (replay dedup, always on)
 *  - missing Authorization header rejected with 401 when requireSignature=true
 *
 * FN-075: Caller pubkey plumbing
 *  - happy path: valid signature → callerPubkey present in on-chain args
 *  - bad signature → 401, submitOnChain NOT called
 *  - body fields differ from signer: callerPubkey reflects signer, body unchanged
 *  - dev-bypass (no verifyBapSignature): callerPubkey absent, no pubkey forged
 */

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';

import {
  handleConfirmTrigger,
  mountOnConfirmCallback,
  type ConfirmTrigger,
  type InboundBppDeps,
} from './inbound-bpp.js';

// ---------- helpers ----------

function makeTrigger(overrides: Partial<ConfirmTrigger> = {}): ConfirmTrigger {
  return {
    kind: 'Confirm',
    bap: 'bap'.repeat(16).slice(0, 44),
    bpp: 'bpp'.repeat(16).slice(0, 44),
    network: 'net'.repeat(16).slice(0, 64),
    task_pda: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    catalog_response_pda: 'cat'.repeat(16).slice(0, 44),
    terms_hash: 'dead'.repeat(16).slice(0, 64),
    emitted_at: 1_700_000_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<InboundBppDeps> = {}): InboundBppDeps {
  return {
    resolveBppEndpoint: vi.fn(() => 'https://bpp.example.com/beckn'),
    postBecknRequest: vi.fn(async () => ({ status: 200, body: { message: { ack: { status: 'ACK' } } } })),
    submitOnChain: vi.fn(async () => ({ tx_signature: 'stub_sig_abc' })),
    ...overrides,
  };
}

// ---------- handleConfirmTrigger ----------

describe('handleConfirmTrigger', () => {
  it('POSTs to the resolved BPP URL with a Beckn /confirm body', async () => {
    const deps = makeDeps();
    const trigger = makeTrigger();

    await handleConfirmTrigger(trigger, deps);

    expect(deps.resolveBppEndpoint).toHaveBeenCalledWith(trigger.bpp);
    expect(deps.postBecknRequest).toHaveBeenCalledOnce();

    const [url, body] = (deps.postBecknRequest as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(url).toBe('https://bpp.example.com/beckn');
    expect(body.context.action).toBe('confirm');
    expect(body.context.bap_id).toBe(trigger.bap);
    expect(body.context.bpp_id).toBe(trigger.bpp);
    expect(body.context.version).toBe('2.0.0');
    expect(body.message).toBeDefined();
  });

  it('includes order from loadOrderByTermsHash when provided', async () => {
    const order = { id: 'order-123', item: 'widget' };
    const deps = makeDeps({
      loadOrderByTermsHash: vi.fn(async () => order),
    });
    const trigger = makeTrigger();

    await handleConfirmTrigger(trigger, deps);

    const [, body] = (deps.postBecknRequest as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(body.message.order).toEqual(order);
  });

  it('falls back to terms_hash stub order when loadOrderByTermsHash is absent', async () => {
    const deps = makeDeps();
    const trigger = makeTrigger();

    await handleConfirmTrigger(trigger, deps);

    const [, body] = (deps.postBecknRequest as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(body.message.order).toEqual({ terms_hash: trigger.terms_hash });
  });

  it('warns but does not throw when BPP returns 4xx', async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.join(' '));
    });
    const deps = makeDeps({
      postBecknRequest: vi.fn(async () => ({ status: 422, body: {} })),
    });

    let threw = false;
    try {
      await handleConfirmTrigger(makeTrigger(), deps);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(warnings.some((w) => w.includes('422'))).toBe(true);
    warnSpy.mockRestore();
  });
});

// ---------- /on_confirm endpoint ----------

let server: Server;
let baseUrl: string;
let deps: InboundBppDeps;

beforeAll(async () => {
  deps = makeDeps();
  const app = express();
  app.use(express.json());
  mountOnConfirmCallback(app, deps);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function postOnConfirm(body: unknown) {
  return fetch(`${baseUrl}/on_confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildOnConfirmBody(orderState: string, extra: Record<string, unknown> = {}, overrideContext: Record<string, unknown> = {}) {
  return {
    context: {
      domain: 'retail',
      action: 'on_confirm',
      version: '2.0.0',
      bap_id: 'bap.example.com',
      bap_uri: 'https://bap.example.com',
      bpp_id: 'bpp.example.com',
      bpp_uri: 'https://bpp.example.com',
      // Generate unique IDs per call so replay dedup doesn't reject subsequent tests
      transaction_id: randomUUID(),
      message_id: randomUUID(),
      timestamp: '2026-04-30T00:00:00.000Z',
      ...overrideContext,
    },
    message: {
      order: {
        id: 'order-pda-001',
        state: orderState,
        ...extra,
      },
    },
  };
}

describe('/on_confirm endpoint', () => {
  it('returns 200 ACK and calls CompleteTask when order.state=COMPLETED', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockClear();
    const res = await postOnConfirm(buildOnConfirmBody('COMPLETED'));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.message.ack.status).toBe('ACK');
    expect(json.tx_signature).toBe('stub_sig_abc');
    expect(deps.submitOnChain).toHaveBeenCalledWith('CompleteTask', expect.any(Object));
  });

  it('returns 200 ACK and calls FailTask when order.state=CANCELLED', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockClear();
    const res = await postOnConfirm(buildOnConfirmBody('CANCELLED'));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.message.ack.status).toBe('ACK');
    expect(deps.submitOnChain).toHaveBeenCalledWith('FailTask', expect.any(Object));
  });

  it('returns 400 with beckn_validation_failed for invalid body', async () => {
    const res = await postOnConfirm({ not_a_valid_beckn: true });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe('beckn_validation_failed');
    expect(json.details).toBeDefined();
  });

  it('returns 500 when submitOnChain throws', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('chain_error'));
    const res = await postOnConfirm(buildOnConfirmBody('COMPLETED'));
    expect(res.status).toBe(500);
    const json = await res.json() as any;
    expect(json.error).toBe('submission_failed');
    expect(json.details).toMatch(/chain_error/);
  });
});

// ---------- becknOnConfirmToTaskOutcome (indirectly via /on_confirm) ----------

describe('fulfillment_uri extraction', () => {
  it('extracts from tracking.url (standard path)', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockClear();
    const body = buildOnConfirmBody('COMPLETED', {
      fulfillment: { tracking: { url: 'https://tracking.example.com/track/123' } },
    });
    await postOnConfirm(body);
    const [, args] = (deps.submitOnChain as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(args.fulfillment_uri).toBe('https://tracking.example.com/track/123');
  });

  it('falls back to artifacts[0].url when tracking.url is absent', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockClear();
    const body = buildOnConfirmBody('COMPLETED', {
      fulfillment: { artifacts: [{ url: 'https://artifacts.example.com/artifact/456' }] },
    });
    await postOnConfirm(body);
    const [, args] = (deps.submitOnChain as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(args.fulfillment_uri).toBe('https://artifacts.example.com/artifact/456');
  });

  it('returns empty string when neither tracking.url nor artifacts present', async () => {
    (deps.submitOnChain as ReturnType<typeof vi.fn>).mockClear();
    const body = buildOnConfirmBody('COMPLETED');
    await postOnConfirm(body);
    const [, args] = (deps.submitOnChain as ReturnType<typeof vi.fn>).mock.calls[0] as [string, any];
    expect(args.fulfillment_uri).toBe('');
  });
});

// ---------- FN-036: Gateway ownership hardening ----------

describe('FN-036: BPP allowlist (expectedBpps)', () => {
  let hardenedServer: Server;
  let hardenedUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const hardenedDeps = makeDeps({
      expectedBpps: new Set(['trusted-bpp.example.com']),
    });
    mountOnConfirmCallback(app, hardenedDeps);
    await new Promise<void>((resolve) => {
      hardenedServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = hardenedServer.address() as AddressInfo;
    hardenedUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      hardenedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects callback with unknown bpp_id with 403', async () => {
    const body = buildOnConfirmBody('COMPLETED', {}, { bpp_id: 'unknown-bpp.example.com', bpp_uri: 'https://unknown-bpp.example.com' });
    const res = await fetch(`${hardenedUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.error).toBe('unknown_bpp');
  });

  it('accepts callback from trusted bpp_id with 200', async () => {
    const body = buildOnConfirmBody('COMPLETED', {}, { bpp_id: 'trusted-bpp.example.com', bpp_uri: 'https://trusted-bpp.example.com' });
    const res = await fetch(`${hardenedUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.message.ack.status).toBe('ACK');
  });
});

describe('FN-036: Replay dedup (seenTransactions)', () => {
  let dedupServer: Server;
  let dedupUrl: string;
  let dedupDeps: InboundBppDeps;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    dedupDeps = makeDeps();
    mountOnConfirmCallback(app, dedupDeps);
    await new Promise<void>((resolve) => {
      dedupServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = dedupServer.address() as AddressInfo;
    dedupUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      dedupServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects duplicate transaction_id with 409', async () => {
    const fixedTxnId = randomUUID();
    const body = buildOnConfirmBody('COMPLETED', {}, { transaction_id: fixedTxnId });

    // First call should succeed
    const first = await fetch(`${dedupUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    // Second call with same transaction_id must be rejected
    const second = await fetch(`${dedupUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
    const json = await second.json() as any;
    expect(json.error).toBe('duplicate_transaction');
  });

  it('accepts two callbacks with distinct transaction_ids', async () => {
    const body1 = buildOnConfirmBody('COMPLETED');
    const body2 = buildOnConfirmBody('CANCELLED');

    const r1 = await fetch(`${dedupUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body1),
    });
    const r2 = await fetch(`${dedupUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body2),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe('FN-036: Signature gate (requireSignature)', () => {
  let sigServer: Server;
  let sigUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountOnConfirmCallback(app, makeDeps({ requireSignature: true }));
    await new Promise<void>((resolve) => {
      sigServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = sigServer.address() as AddressInfo;
    sigUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      sigServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects request with no Authorization header with 401', async () => {
    const body = buildOnConfirmBody('COMPLETED');
    const res = await fetch(`${sigUrl}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error).toBe('missing_signature');
  });

  it('accepts request with Authorization header present', async () => {
    const body = buildOnConfirmBody('COMPLETED');
    const res = await fetch(`${sigUrl}/on_confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Signature keyId="bpp.example.com",signature="stub"',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.message.ack.status).toBe('ACK');
  });
});

// ---------- FN-075: Caller pubkey plumbing ----------

describe('FN-075: verifyBapSignature — callerPubkey plumbing on /on_confirm', () => {
  const SIGNER_PUBKEY = 'a'.repeat(64); // canonical lowercase hex

  function buildServer(deps: Partial<InboundBppDeps>) {
    const app = express();
    app.use(express.json());
    mountOnConfirmCallback(app, makeDeps(deps));
    return new Promise<{ server: Server; url: string }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({ server: s, url: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  it('happy path: valid signature → callerPubkey in on-chain args, submitOnChain called', async () => {
    const submitMock = vi.fn(async () => ({ tx_signature: 'stub_sig' }));
    const { server, url } = await buildServer({
      verifyBapSignature: () => SIGNER_PUBKEY,
      submitOnChain: submitMock,
    });

    const body = buildOnConfirmBody('COMPLETED');
    const res = await fetch(`${url}/on_confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Signature keyId="${SIGNER_PUBKEY}",signature="valid"`,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledOnce();
    const [, args] = submitMock.mock.calls[0] as [string, any];
    expect(args.caller_pubkey).toBe(SIGNER_PUBKEY);

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('bad signature → 401, submitOnChain NOT called', async () => {
    const submitMock = vi.fn(async () => ({ tx_signature: 'stub_sig' }));
    const { server, url } = await buildServer({
      verifyBapSignature: () => null, // verification always fails
      submitOnChain: submitMock,
    });

    const body = buildOnConfirmBody('COMPLETED');
    const res = await fetch(`${url}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(401);
    const json = await res.json() as any;
    expect(json.error).toBe('invalid_signature');
    expect(submitMock).not.toHaveBeenCalled();

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('body bap_id differs from signer: callerPubkey reflects signer, body unchanged', async () => {
    const submitMock = vi.fn(async () => ({ tx_signature: 'stub_sig' }));
    const { server, url } = await buildServer({
      verifyBapSignature: () => SIGNER_PUBKEY,
      submitOnChain: submitMock,
    });

    const body = buildOnConfirmBody('COMPLETED', {}, { bap_id: 'different-bap.example.com' });
    const res = await fetch(`${url}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledOnce();
    const [, args] = submitMock.mock.calls[0] as [string, any];
    // callerPubkey is the signer — not the body bap_id
    expect(args.caller_pubkey).toBe(SIGNER_PUBKEY);
    // bap_id from body is passed through unchanged (handler enforces equality)
    expect(args.bap_id).toBe('different-bap.example.com');

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  it('dev-bypass (no verifyBapSignature): caller_pubkey absent, no pubkey forged', async () => {
    const submitMock = vi.fn(async () => ({ tx_signature: 'stub_sig' }));
    const { server, url } = await buildServer({
      // verifyBapSignature intentionally absent — simulates dev/no-sig mode
      submitOnChain: submitMock,
    });

    const body = buildOnConfirmBody('COMPLETED');
    const res = await fetch(`${url}/on_confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    expect(submitMock).toHaveBeenCalledOnce();
    const [, args] = submitMock.mock.calls[0] as [string, any];
    // Must NOT have a forged pubkey — undefined means no verification ran
    expect(args.caller_pubkey).toBeUndefined();

    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });
});
