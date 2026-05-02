/**
 * Outbound BAP role — when an on-chain agent (acting as Beckn BAP) emits a
 * Search AgentTrigger, this module:
 *   1. Constructs a Beckn v2.0 LTS /search HTTP body
 *   2. POSTs to the configured external BG (Beckn Gateway) endpoint
 *   3. Receives /on_search callback POSTs from external BPPs
 *   4. Validates them, translates to CatalogResponse args, submits on chain
 *
 * Spec: T-2.8.2.2 (FN-089). Pairs with inbound-bap (FN-088) which goes the
 * opposite direction.
 */

import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { validateBecknRequest } from './beckn-schemas.js';

export interface AgentTrigger {
  kind: 'Search' | 'Select' | 'Init' | 'Confirm';
  bap: string;                   // hex pubkey
  bpp: string;                   // hex pubkey ([0; 32] for broadcast)
  network: string;               // hex 32-byte network_id
  intent_hash: string;           // hex 32-byte
  max_responses: number;
  deadline_slot: number;
  emitted_at: number;
}

export interface OutboundBapDeps {
  /** Resolve an external Beckn endpoint URL for a given network_id. */
  resolveEndpoint: (network_id: string) => string;
  /** HTTP POST a Beckn JSON body to a URL. Returns the (sync) ACK envelope. */
  postBecknRequest: (url: string, body: object) => Promise<{ status: number; body: unknown }>;
  /** Submit an on-chain instruction. STUBBED today. */
  submitOnChain: (action: 'PublishCatalogResponse', args: unknown) => Promise<{ tx_signature: string }>;
  /** Look up the off-chain intent payload by hash so we can put it in the Beckn body. */
  loadIntentByHash?: (intent_hash: string) => Promise<object | null>;
}

/** Handle an outbound /search produced by an on-chain Search AgentTrigger. */
export async function handleSearchTrigger(trigger: AgentTrigger, deps: OutboundBapDeps): Promise<void> {
  if (trigger.kind !== 'Search') return;
  const url = deps.resolveEndpoint(trigger.network);
  const intent = (await deps.loadIntentByHash?.(trigger.intent_hash)) ?? { intent_hash: trigger.intent_hash };
  const body = {
    context: {
      domain: 'retail',  // operator-configurable; placeholder for v0
      action: 'search',
      version: '2.0.0',
      bap_id: trigger.bap,
      bap_uri: process.env['BRIDGE_BAP_URI'] ?? 'https://bridge.eto.network',
      transaction_id: trigger.intent_hash.slice(0, 36),  // reuse intent_hash as deterministic transaction id
      message_id: trigger.intent_hash.slice(0, 36),
      timestamp: new Date().toISOString(),
      ttl: 'PT' + Math.max(1, trigger.deadline_slot - trigger.emitted_at) + 'S',
    },
    message: { intent },
  };
  const ack = await deps.postBecknRequest(url, body);
  if (ack.status >= 400) {
    console.warn(`[outbound-bap] external BG rejected /search: ${ack.status}`);
  }
}

/** Mount the /on_search callback receiver on the bridge's express app. */
export function mountOnSearchCallback(app: Express, deps: OutboundBapDeps): void {
  app.post('/on_search', async (req: Request, res: Response) => {
    const v = validateBecknRequest('on_search', req.body);
    if (!v.ok) {
      res.status(400).json({ error: 'beckn_validation_failed', details: v.errors });
      return;
    }
    try {
      const args = becknOnSearchToCatalogResponse(req.body);
      const { tx_signature } = await deps.submitOnChain('PublishCatalogResponse', args);
      res.status(200).json({ message: { ack: { status: 'ACK' } }, tx_signature });
    } catch (err) {
      res.status(500).json({ error: 'submission_failed', details: String(err) });
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function becknOnSearchToCatalogResponse(body: any) {
  // Beckn /on_search body has providers[] under message.catalog. Each provider
  // becomes a separate CatalogResponse on chain.
  return {
    bpp_id: body.context?.bpp_id,
    transaction_id: body.context?.transaction_id,
    catalog_uri: body.message?.catalog?.uri ?? null,
    catalog_hash: body.message?.catalog?.hash ?? null,
    providers: body.message?.catalog?.providers ?? [],
    received_at_iso: new Date().toISOString(),
  };
}

/** Default stub `submitOnChain` for v0 use. */
export const stubSubmit: OutboundBapDeps['submitOnChain'] = async (action, args) => {
  const sig = createHash('sha256').update(action + JSON.stringify(args)).digest('hex').slice(0, 64);
  console.log(`[STUB] would submit ${action} on-chain — tx=${sig}`);
  return { tx_signature: sig };
};
