/**
 * Inbound BPP role — when an on-chain Confirm AgentTrigger fires, this
 * module POSTs the Beckn /confirm payload to the external BPP and receives
 * the asynchronous /on_confirm callback (which carries the completion
 * artifact / fulfillment URI to write back on chain).
 *
 * Spec: T-2.8.2.3 (FN-090). Sibling roles: inbound-bap (FN-088),
 * outbound-bap (FN-089).
 *
 * ## Gateway ownership hardening (FN-036)
 *
 * Three security controls added to mountOnConfirmCallback:
 *
 *   1. BPP allowlist  — when `expectedBpps` is provided, callbacks from
 *      unknown `context.bpp_id` values are rejected with HTTP 403.
 *
 *   2. Replay dedup   — ON BY DEFAULT. The seen-transaction set is keyed on
 *      `context.transaction_id`. Duplicate callbacks are rejected with HTTP 409.
 *      Pass `seenTransactions` to inject a pre-populated set (e.g. in tests).
 *      The txn_id is committed to the set *before* `submitOnChain` is called
 *      to prevent any double-trigger under concurrent requests.
 *
 *   3. Signature gate — when `requireSignature: true`, the handler rejects
 *      requests that lack an `Authorization` header with HTTP 401.
 *      Full Beckn Ed25519 signature verification is deferred; this is a
 *      presence-only guard that prevents entirely unsigned inbound traffic.
 *
 * ## Caller pubkey plumbing (FN-075)
 *
 * `callerPubkey` is the verified BAP signing key surfaced to downstream bank
 * BPP handlers as `AuthenticatedRequest<T>.callerPubkey`. It is produced
 * exclusively by the deps-injected `verifyBapSignature` function, which
 * inspects the inbound HTTP request (e.g. the Beckn `Authorization: Signature`
 * header) and returns the signer's lowercase hex pubkey, or `null` on failure.
 *
 * Canonical encoding: lowercase hex (matches `assertCallerEquals` in
 * `keeper/bpps/bank/auth.ts`).
 *
 * Dev-bypass (fail-closed): when no `verifyBapSignature` is injected,
 * `callerPubkey` is `undefined`. Handlers that call
 * `assertCallerEquals(undefined, …)` reject with `unauthorized_caller`.
 * The gateway MUST NOT forge a `callerPubkey` in any code path.
 *
 * Contract for BPP handler authors: `callerPubkey` passed in the task outcome
 * args is the ONLY trusted principal. Body-supplied pubkeys (`subject`,
 * `holder`, `funder`) are untrusted until the handler asserts equality with
 * `callerPubkey` via `assertCallerEquals`.
 */

import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { validateBecknRequest } from './beckn-schemas.js';

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

  // ---- FN-036: Gateway ownership hardening ----

  /**
   * Allowlist of trusted BPP identifiers (context.bpp_id values).
   * When provided, callbacks from BPPs not in this set are rejected 403.
   * When absent (default), all bpp_ids are accepted.
   */
  expectedBpps?: Set<string>;

  /**
   * Inject a pre-populated seen-transactions set.
   * Defaults to a fresh Set created at mount time (replay dedup is always on).
   * Callers can pass their own Set to share state across mount calls or to
   * pre-seed transactions that must be treated as already seen.
   */
  seenTransactions?: Set<string>;

  /**
   * When true, requests without an `Authorization` header are rejected 401.
   * Defaults to false. Full Beckn Ed25519 verification is deferred (stub-level).
   */
  requireSignature?: boolean;

  // ---- FN-075: Caller pubkey plumbing ----

  /**
   * Extract the verified BAP signing pubkey from the inbound HTTP request.
   *
   * Implementations SHOULD inspect the `Authorization: Signature …` header,
   * verify the Beckn Ed25519 signature, and return the signer's lowercase hex
   * pubkey on success, or `null` when verification fails.
   *
   * When absent (default), `callerPubkey` is `undefined` — the gateway does
   * NOT forge a pubkey. Handlers will reject with `unauthorized_caller`.
   *
   * When present and returns `null`, the request is rejected with HTTP 401
   * before any handler is invoked.
   */
  verifyBapSignature?: (req: Request) => string | null;
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

  // FN-036: replay dedup set — always on; caller may inject a pre-populated set.
  const seenTransactions: Set<string> = deps.seenTransactions ?? new Set();

  app.post('/on_confirm', async (req: Request, res: Response) => {
    // 1. Schema validation (existing)
    const v = validateBecknRequest('on_confirm', req.body);
    if (!v.ok) {
      return res.status(400).json({ error: 'beckn_validation_failed', details: (v as { ok: false; errors: unknown }).errors });
    }

    // 2. FN-075: Extract verified caller pubkey (before FN-036 guards so a
    //    bad signature short-circuits before any allowlist / dedup logic runs).
    //    When verifyBapSignature is present and returns null → 401, no dispatch.
    //    When verifyBapSignature is absent → callerPubkey remains undefined
    //    (fail-closed: handlers will reject via assertCallerEquals).
    let callerPubkey: string | undefined;
    if (deps.verifyBapSignature !== undefined) {
      const verified = deps.verifyBapSignature(req);
      if (verified === null) {
        return res.status(401).json({ error: 'invalid_signature', details: 'BAP signature verification failed' });
      }
      callerPubkey = verified.toLowerCase();
    }

    // 3. FN-036: Signature presence gate (optional, off by default)
    if (deps.requireSignature && !req.headers['authorization']) {
      return res.status(401).json({ error: 'missing_signature', details: 'Authorization header required' });
    }

    // 4. FN-036: BPP allowlist check (optional, off by default)
    const bppId: string | undefined = req.body.context?.bpp_id;
    if (deps.expectedBpps && (!bppId || !deps.expectedBpps.has(bppId))) {
      return res.status(403).json({ error: 'unknown_bpp', details: `bpp_id not in allowlist: ${bppId ?? '(missing)'}` });
    }

    // 5. FN-036: Replay dedup (always on — commit before submit to prevent double-trigger)
    const txnId: string | undefined = req.body.context?.transaction_id;
    if (txnId) {
      if (seenTransactions.has(txnId)) {
        return res.status(409).json({ error: 'duplicate_transaction', details: `transaction_id already processed: ${txnId}` });
      }
      seenTransactions.add(txnId);
    }

    try {
      const order = req.body.message?.order;
      const success = order?.state === 'COMPLETED' || order?.state === 'FULFILLED';
      const args = becknOnConfirmToTaskOutcome(req.body, callerPubkey);
      const { tx_signature } = await resolvedSubmit(success ? 'CompleteTask' : 'FailTask', args);
      res.status(200).json({ message: { ack: { status: 'ACK' } }, tx_signature });
    } catch (err) {
      res.status(500).json({ error: 'submission_failed', details: String(err) });
    }
  });
}

function becknOnConfirmToTaskOutcome(body: any, callerPubkey?: string) {
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
    // FN-075: verified BAP signing key — undefined when no verifier injected
    caller_pubkey: callerPubkey,
  };
}

/** Default stub for v0 use. */
export const stubSubmit: InboundBppDeps['submitOnChain'] = async (action, args) => {
  const sig = createHash('sha256').update(action + JSON.stringify(args)).digest('hex').slice(0, 64);
  console.log(`[STUB] would submit ${action} on-chain — tx=${sig}`);
  return { tx_signature: sig };
};
