/**
 * Tests for outbound-bap.ts (FN-089 / T-2.8.2.2).
 *
 * Covers:
 *   - handleSearchTrigger: builds correct Beckn /search body and POSTs it
 *   - handleSearchTrigger: non-Search kinds are no-ops
 *   - POST /on_search with valid body → 200 + tx_signature
 *   - POST /on_search with invalid body → 400 + errors
 *   - becknOnSearchToCatalogResponse (via /on_search handler): extracts providers
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  handleSearchTrigger,
  mountOnSearchCallback,
  stubSubmit,
  type AgentTrigger,
  type OutboundBapDeps,
} from './outbound-bap.js';

// ---------- Fixtures ----------

const SEARCH_TRIGGER: AgentTrigger = {
  kind: 'Search',
  bap: 'aabbccdd00112233',
  bpp: '0000000000000000000000000000000000000000000000000000000000000000',
  network: 'deadbeef01020304050607080910111213141516171819202122232425262728',
  intent_hash: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
  max_responses: 5,
  deadline_slot: 1000,
  emitted_at: 900,
};

// A valid on_search body that satisfies the beckn-schemas validator.
// Required: context with action=on_search, version=2.0.0, uuid transaction_id/message_id,
// date-time timestamp, bap_id, bap_uri; message.catalog.providers[0].id
function validOnSearchBody(overrides: Record<string, unknown> = {}) {
  return {
    context: {
      domain: 'retail',
      action: 'on_search',
      version: '2.0.0',
      bap_id: 'bap.example.com',
      bap_uri: 'https://bap.example.com/beckn',
      bpp_id: 'bpp.example.com',
      bpp_uri: 'https://bpp.example.com/beckn',
      transaction_id: '550e8400-e29b-41d4-a716-446655440000',
      message_id: '550e8400-e29b-41d4-a716-446655440001',
      timestamp: '2026-04-30T00:00:00.000Z',
    },
    message: {
      catalog: {
        providers: [
          {
            id: 'prov-1',
            descriptor: { name: 'Provider One' },
            items: [],
          },
        ],
      },
    },
    ...overrides,
  };
}

// ---------- handleSearchTrigger ----------

describe('handleSearchTrigger', () => {
  it('calls postBecknRequest with a properly-shaped Beckn /search body', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const deps: OutboundBapDeps = {
      resolveEndpoint: () => 'https://bg.example.com/search',
      postBecknRequest: async (url, body) => {
        posted.push({ url, body });
        return { status: 200, body: { message: { ack: { status: 'ACK' } } } };
      },
      submitOnChain: stubSubmit,
    };

    await handleSearchTrigger(SEARCH_TRIGGER, deps);

    expect(posted).toHaveLength(1);
    const { url, body } = posted[0]!;
    expect(url).toBe('https://bg.example.com/search');

    const b = body as any;
    expect(b.context.action).toBe('search');
    expect(b.context.version).toBe('2.0.0');
    expect(b.context.bap_id).toBe(SEARCH_TRIGGER.bap);
    expect(b.context.transaction_id).toBe(SEARCH_TRIGGER.intent_hash.slice(0, 36));
    expect(b.context.ttl).toBe('PT100S');   // max(1, 1000 - 900) = 100
    expect(b.message.intent).toHaveProperty('intent_hash', SEARCH_TRIGGER.intent_hash);
  });

  it('uses loadIntentByHash result when provided', async () => {
    const posted: unknown[] = [];
    const deps: OutboundBapDeps = {
      resolveEndpoint: () => 'https://bg.example.com/search',
      postBecknRequest: async (_url, body) => {
        posted.push(body);
        return { status: 200, body: {} };
      },
      submitOnChain: stubSubmit,
      loadIntentByHash: async () => ({ item: { descriptor: { name: 'Widget' } } }),
    };

    await handleSearchTrigger(SEARCH_TRIGGER, deps);

    const b = posted[0] as any;
    expect(b.message.intent).toHaveProperty('item');
  });

  it.each(['Select', 'Init', 'Confirm'] as const)(
    'is a no-op for kind=%s',
    async (kind) => {
      const postMock = vi.fn();
      const deps: OutboundBapDeps = {
        resolveEndpoint: () => 'https://bg.example.com/search',
        postBecknRequest: postMock,
        submitOnChain: stubSubmit,
      };
      await handleSearchTrigger({ ...SEARCH_TRIGGER, kind }, deps);
      expect(postMock).not.toHaveBeenCalled();
    },
  );
});

// ---------- mountOnSearchCallback via HTTP ----------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountOnSearchCallback(app, {
    resolveEndpoint: () => 'https://bg.example.com',
    postBecknRequest: async () => ({ status: 200, body: {} }),
    submitOnChain: stubSubmit,
  });
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

describe('POST /on_search callback receiver', () => {
  it('returns 200 with tx_signature for a valid on_search body', async () => {
    const res = await fetch(`${baseUrl}/on_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validOnSearchBody()),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.message.ack.status).toBe('ACK');
    expect(typeof body.tx_signature).toBe('string');
    expect(body.tx_signature).toHaveLength(64);
  });

  it('returns 400 with errors for an invalid body (missing context)', async () => {
    const res = await fetch(`${baseUrl}/on_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('beckn_validation_failed');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('returns 400 for empty body', async () => {
    const res = await fetch(`${baseUrl}/on_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('beckn_validation_failed');
  });

  it('extracts providers correctly from the catalog', async () => {
    const submitCalls: unknown[] = [];
    const app2 = express();
    app2.use(express.json());
    mountOnSearchCallback(app2, {
      resolveEndpoint: () => 'https://bg.example.com',
      postBecknRequest: async () => ({ status: 200, body: {} }),
      submitOnChain: async (_action, args) => {
        submitCalls.push(args);
        return { tx_signature: 'deadbeef'.repeat(8) };
      },
    });
    const s2 = await new Promise<Server>((resolve) => {
      const srv = app2.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const port2 = (s2.address() as AddressInfo).port;
    const base2 = `http://127.0.0.1:${port2}`;

    const onSearchBody = validOnSearchBody();
    await fetch(`${base2}/on_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(onSearchBody),
    });

    await new Promise<void>((resolve, reject) => {
      s2.close((err) => (err ? reject(err) : resolve()));
    });

    expect(submitCalls).toHaveLength(1);
    const args = submitCalls[0] as any;
    expect(Array.isArray(args.providers)).toBe(true);
    expect(args.providers[0].id).toBe('prov-1');
    expect(args.transaction_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(args.bpp_id).toBe('bpp.example.com');
  });
});
