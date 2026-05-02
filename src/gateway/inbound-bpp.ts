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
import type { Express, Request, RequestHandler, Response } from 'express';
import { validateBecknRequest } from './beckn-schemas.js';
import { becknError } from './beckn.js';
import type { BecknBridgeConfig } from '../config.js';

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
  /** Submit on-chain instruction. STUBBED today. */
  submitOnChain: (action: 'CompleteTask' | 'FailTask', args: unknown) => Promise<{ tx_signature: string }>;
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
  app.post('/on_confirm', async (req: Request, res: Response) => {
    const v = validateBecknRequest('on_confirm', req.body);
    if (!v.ok) {
      return res.status(400).json({ error: 'beckn_validation_failed', details: (v as { ok: false; errors: unknown }).errors });
    }
    try {
      const order = req.body.message?.order;
      const success = order?.state === 'COMPLETED' || order?.state === 'FULFILLED';
      const args = becknOnConfirmToTaskOutcome(req.body);
      const { tx_signature } = await deps.submitOnChain(success ? 'CompleteTask' : 'FailTask', args);
      res.status(200).json({ message: { ack: { status: 'ACK' } }, tx_signature });
    } catch (err) {
      res.status(500).json({ error: 'submission_failed', details: String(err) });
    }
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

// ---------------------------------------------------------------------------
// createInboundBppConfirmHandler — Express RequestHandler factory (FN-090)
// ---------------------------------------------------------------------------

/**
 * The Beckn on_confirm envelope: the response the external BPP sends back
 * after processing /confirm.
 */
export type OnConfirmEnvelope = {
  context: {
    domain: string;
    action: "on_confirm";
    version: string;
    bap_id: string;
    bap_uri: string;
    transaction_id: string;
    message_id: string;
    timestamp: string;
    bpp_id?: string;
    bpp_uri?: string;
    [key: string]: unknown;
  };
  message: { order: Record<string, unknown> };
};

/**
 * Injectable function that forwards the /confirm request to the external BPP
 * and returns the on_confirm envelope.
 */
export type ForwardConfirmFn = (
  req: { context: Record<string, unknown>; message: unknown }
) => Promise<{ ok: boolean; onConfirm: OnConfirmEnvelope }>;

/**
 * Injectable function that POSTs the on_confirm envelope back to the BAP.
 */
export type PostBapCallbackFn = (
  url: string,
  body: OnConfirmEnvelope,
  ctx: Record<string, unknown>
) => Promise<void>;

/**
 * Check whether the BAP URI's hostname is allowed by the config's allowlist.
 * Returns true if:
 *  - `allowedHosts` contains "*" (wildcard)
 *  - `allowedHosts` contains the hostname of `bapUri`
 * Returns false if `allowedHosts` is empty or the hostname is not listed.
 */
export function isBapUriAllowed(bapUri: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return false;
  if (allowedHosts.includes('*')) return true;
  try {
    const { hostname } = new URL(bapUri);
    return allowedHosts.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Default forward implementation: POSTs the confirm body to the
 * `config.bppBackendUrl` and expects a JSON on_confirm envelope.
 */
export const defaultForwardConfirm: ForwardConfirmFn = async (req) => {
  // No-op default that echoes back a synthetic on_confirm context
  const onConfirm: OnConfirmEnvelope = {
    context: {
      ...(req.context as object),
      action: 'on_confirm' as const,
      timestamp: new Date().toISOString(),
    } as OnConfirmEnvelope['context'],
    message: { order: {} },
  };
  return { ok: true, onConfirm };
};

/**
 * Default postCallback implementation: POSTs the on_confirm envelope to the
 * BAP URI using the global fetch.
 */
export const defaultPostBapCallback: PostBapCallbackFn = async (url, body) => {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[inbound-bpp] callback failed', err);
  }
};

/**
 * Build an Express RequestHandler that implements the inbound BPP role:
 *  1. Validates Content-Type (415 on non-JSON)
 *  2. Checks `config.enabled` (503 on disabled)
 *  3. Validates Beckn envelope (400 on invalid)
 *  4. Returns 200 ACK synchronously
 *  5. Fire-and-forgets: forward to external BPP, then POST on_confirm to BAP
 */
export function createInboundBppConfirmHandler(opts: {
  config: BecknBridgeConfig;
  forward?: ForwardConfirmFn;
  postCallback?: PostBapCallbackFn;
}): RequestHandler {
  const forward = opts.forward ?? defaultForwardConfirm;
  const postCallback = opts.postCallback ?? defaultPostBapCallback;

  return (req: Request, res: Response): void => {
    const ct = req.header('content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) {
      const { status, body } = becknError('BECKN_415', `Expected Content-Type application/json, got '${ct || 'none'}'`, 415);
      res.status(status).json(body);
      return;
    }

    if (!opts.config.enabled) {
      const { status, body } = becknError('BECKN_503', 'BPP role is not enabled on this bridge instance', 503);
      res.status(status).json(body);
      return;
    }

    const v = validateBecknRequest('confirm', req.body ?? {});
    if (!v.ok) {
      const { status, body } = becknError(
        'BECKN_400',
        `Invalid Beckn envelope: ${(v as { ok: false; errors: unknown[] }).errors.map((e: unknown) => String(e)).join('; ')}`,
        400,
      );
      res.status(status).json(body);
      return;
    }

    // Respond with ACK synchronously
    res.status(200).json({ message: { ack: { status: 'ACK' } } });

    // Fire-and-forget: forward → callback
    const reqBody = req.body as { context: Record<string, unknown>; message: unknown };
    const bapUri = typeof reqBody.context?.bap_uri === 'string' ? reqBody.context.bap_uri : '';

    void (async () => {
      try {
        const { onConfirm } = await forward(reqBody);

        if (bapUri && isBapUriAllowed(bapUri, opts.config.bapCallbackAllowedHosts)) {
          await postCallback(bapUri, onConfirm, reqBody.context);
        }
      } catch (err) {
        console.warn('[inbound-bpp] forward/callback error', err);
      }
    })();
  };
}
