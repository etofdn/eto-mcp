/**
 * Inbound BPP role — when an on-chain Confirm AgentTrigger fires, this
 * module POSTs the Beckn /confirm payload to the external BPP and receives
 * the asynchronous /on_confirm callback (which carries the completion
 * artifact / fulfillment URI to write back on chain).
 *
 * Spec: T-2.8.2.3 (FN-090). Sibling roles: inbound-bap (FN-088),
 * outbound-bap (FN-089).
 */

import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { validateBecknRequest } from './beckn-schemas.js';
import { validateBecknEnvelope, validateBecknEnvelopeFreshness } from './inbound-bap.js';

export interface ConfirmTrigger {
  kind: 'Confirm';
  bap: string;           // hex pubkey
  bpp: string;           // hex pubkey
  network: string;       // hex 32-byte network_id
  task_pda: string;      // hex pubkey of the Task PDA
  catalog_response_pda: string;
  terms_hash: string;    // hex 32-byte
  emitted_at: number;
}

export interface InboundBppDeps {
  /** Resolve the external HTTP endpoint for a BPP pubkey. */
  resolveBppEndpoint: (bpp_pubkey: string) => string;
  /** POST a Beckn JSON body to a URL. */
  postBecknRequest: (url: string, body: object) => Promise<{ status: number; body: unknown }>;
  /**
   * Submit on-chain instruction. Optional — when omitted, the deps default
   * to the ambient ChainClient (FN-091): real `SvmChainClient` if
   * `ETO_RPC_ENDPOINT` is set, otherwise `StubChainClient`. Existing
   * callers that pass an explicit `submitOnChain` continue to work.
   */
  submitOnChain?: (action: 'CompleteTask' | 'FailTask', args: unknown) => Promise<{ tx_signature: string }>;
  /** FN-091: optional chain client; falls back to createDefaultChainClient(). */
  chainClient?: import("./chain-client.js").ChainClient;
  /** Look up off-chain order details by terms_hash. */
  loadOrderByTermsHash?: (terms_hash: string) => Promise<object | null>;
}

/** Handle an outbound /confirm produced by an on-chain Confirm AgentTrigger. */
export async function handleConfirmTrigger(trigger: ConfirmTrigger, deps: InboundBppDeps): Promise<void> {
  if (trigger.kind !== 'Confirm') return;
  const url = deps.resolveBppEndpoint(trigger.bpp);
  const order = (await deps.loadOrderByTermsHash?.(trigger.terms_hash)) ?? { terms_hash: trigger.terms_hash };
  const body = {
    context: {
      domain: 'retail',
      action: 'confirm',
      version: '2.0.0',
      bap_id: trigger.bap,
      bap_uri: process.env.BRIDGE_BAP_URI ?? 'https://bridge.eto.network',
      bpp_id: trigger.bpp,
      bpp_uri: url,
      transaction_id: trigger.task_pda.slice(0, 36),
      message_id: trigger.task_pda.slice(0, 36),
      timestamp: new Date().toISOString(),
    },
    message: { order },
  };
  const ack = await deps.postBecknRequest(url, body);
  if (ack.status >= 400) {
    console.warn(`[inbound-bpp] external BPP rejected /confirm: ${ack.status}`);
  }
}

/** Mount the /on_confirm callback receiver on the bridge express app. */
export function mountOnConfirmCallback(app: Express, deps: InboundBppDeps): void {
  // FN-091: resolve effective submit function once at mount time.
  const resolvedSubmit: NonNullable<InboundBppDeps['submitOnChain']> =
    deps.submitOnChain ??
    (async (action, args) => {
      const cc = deps.chainClient ?? (await import('./chain-client.js')).createDefaultChainClient();
      const r = await cc.submit(action, args);
      return { tx_signature: r.tx_signature };
    });

  app.post('/on_confirm', async (req: Request, res: Response) => {
    // FN-055 / FN-074 parity: envelope hardening BEFORE Ajv schema validation.
    // Order per gateway rules: (signature →) envelope validate → schema validate
    //   → (idempotency →) handler. Signature/idempotency are not yet wired in
    //   this gateway (see MEMORY.md FN-086 compliance gap); ordering is
    //   preserved here so they can be slotted in without code churn.
    const now = Date.now();
    const ctx = (req.body as Record<string, unknown> | undefined)?.context;
    const env = validateBecknEnvelope(ctx, now);
    if (!env.ok) {
      return res.status(env.status).json(env.body);
    }
    const v = validateBecknRequest('on_confirm', req.body);
    if (!v.ok) {
      return res.status(400).json({ error: 'beckn_validation_failed', details: (v as { ok: false; errors: unknown }).errors });
    }
    const fresh = validateBecknEnvelopeFreshness(ctx, now);
    if (!fresh.ok) {
      return res.status(fresh.status).json(fresh.body);
    }
    try {
      const order = req.body.message?.order;
      const success = order?.state === 'COMPLETED' || order?.state === 'FULFILLED';
      const args = becknOnConfirmToTaskOutcome(req.body);
      const { tx_signature } = await resolvedSubmit(success ? 'CompleteTask' : 'FailTask', args);
      res.status(200).json({ message: { ack: { status: 'ACK' } }, tx_signature });
    } catch (err) {
      res.status(500).json({ error: 'submission_failed', details: String(err) });
    }
  });
}

/**
 * FN-055: mount additional BPP→BAP callback receivers with the same FN-074
 * envelope hardening applied to `/on_confirm` above.
 *
 * Currently wires `/on_select` (the BPP’s quoted-order callback). Other
 * BPP-origin callbacks (`/on_init`, `/on_status`, `/on_cancel`, `/on_rating`,
 * `/on_support`) can be added here following the same shape once their
 * on-chain handlers are defined; until then the envelope+schema gate is the
 * critical hardening surface.
 *
 * NOTE: `/on_search` is owned by `outbound-bap.ts` (the BAP role that issued
 * the original `/search` is the legitimate receiver of the catalog callback);
 * envelope hardening for that route lives there. This function is only for
 * BPP-origin callbacks that do not already have a home.
 *
 * Pipeline order (mirrors `/on_confirm` and `inbound-bap.ts` `/search`,
 * `/select`):
 *   1. validateBecknEnvelope            → 400 NACK on BAD_VERSION/TIMESTAMP/TTL/EXPIRED_TTL
 *   2. validateBecknRequest (Ajv)       → 400 beckn_validation_failed
 *   3. validateBecknEnvelopeFreshness   → 400 NACK on EXPIRED_TTL (re-check)
 *   4. handler
 */
export function mountInboundBppCallbacks(app: Express, _deps: InboundBppDeps): void {
  app.post('/on_select', async (req: Request, res: Response) => {
    const now = Date.now();
    const ctx = (req.body as Record<string, unknown> | undefined)?.context;
    const env = validateBecknEnvelope(ctx, now);
    if (!env.ok) {
      return res.status(env.status).json(env.body);
    }
    const v = validateBecknRequest('on_select', req.body);
    if (!v.ok) {
      return res.status(400).json({
        error: 'beckn_validation_failed',
        details: (v as { ok: false; errors: unknown }).errors,
      });
    }
    const fresh = validateBecknEnvelopeFreshness(ctx, now);
    if (!fresh.ok) {
      return res.status(fresh.status).json(fresh.body);
    }
    // No on-chain handler defined yet for `/on_select`; return a stable ACK so
    // the envelope+schema gate can be exercised by integration tests and BPPs
    // can complete the protocol handshake without a chain submission.
    res.status(200).json({
      message: { ack: { status: 'ACK' } },
      context: ctx,
    });
  });
}

function becknOnConfirmToTaskOutcome(body: any) {
  const order = body.message?.order ?? {};
  const fulfillment_uri = order?.fulfillment?.tracking?.url
    ?? order?.fulfillment?.artifacts?.[0]?.url
    ?? '';
  return {
    bpp_id: body.context?.bpp_id,
    bap_id: body.context?.bap_id,
    task_pda: order.id,
    fulfillment_uri,
    state: order.state ?? 'UNKNOWN',
    received_at_iso: new Date().toISOString(),
  };
}

/** Default stub for v0 use. */
export const stubSubmit: InboundBppDeps['submitOnChain'] = async (action, args) => {
  const sig = createHash('sha256').update(action + JSON.stringify(args)).digest('hex').slice(0, 64);
  console.log(`[STUB] would submit ${action} on-chain — tx=${sig}`);
  return { tx_signature: sig };
};
