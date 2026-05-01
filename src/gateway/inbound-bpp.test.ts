/**
 * Tests for FN-090 — Inbound BPP gateway role.
 *
 * Covers:
 *  - handleConfirmTrigger POSTs to resolved URL with proper Beckn /confirm body
 *  - /on_confirm with order.state=COMPLETED -> submits CompleteTask
 *  - /on_confirm with order.state=CANCELLED -> submits FailTask
 *  - /on_confirm with invalid body -> 400 with errors
 *  - fulfillment_uri extraction from tracking.url and artifacts[0].url fallback
 */

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

function buildOnConfirmBody(orderState: string, extra: Record<string, unknown> = {}) {
  return {
    context: {
      domain: 'retail',
      action: 'on_confirm',
      version: '2.0.0',
      bap_id: 'bap.example.com',
      bap_uri: 'https://bap.example.com',
      bpp_id: 'bpp.example.com',
      bpp_uri: 'https://bpp.example.com',
      transaction_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      message_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
      timestamp: '2026-04-30T00:00:00.000Z',
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
