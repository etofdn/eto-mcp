/**
 * Open Checking BPP handler (FN-115 / T-3.11.1.2).
 *
 * Inbound: Beckn /confirm payload from the bridge with order.items =
 *   [{ id: 'open-checking-account', ... }].
 * Outbound: signs CompleteTask with the new CheckingAccount PDA in the
 *   fulfillment_uri, having issued an account.checking credential to the
 *   subject and recorded the new account in the local mock ledger.
 *
 * Pre-conditions enforced by the on-chain Init gate (FN-052,
 * programs/beckn/instructions/init.rs) via required_credentials on the Network:
 *   - subject MUST present a valid `verified-human` credential
 *   - subject MUST present a valid `kyc.us-test` credential
 *
 * This handler runs AFTER the chain has already verified these credentials.
 * The handler defensively re-checks via verifyHolderCredentials as a
 * belt-and-braces guard against mis-routed requests that bypass Init.
 *
 * Side-effect ordering:
 *   Step 1 — recordCheckingAccount (off-chain ledger)
 *   Step 2 — issueCheckingCredential (on-chain, STUBBED in v0)
 *
 * Atomicity note: v0 is best-effort. If issueCheckingCredential fails after
 * recordCheckingAccount succeeds, the ledger entry is orphaned. A v1 GC sweeper
 * will reconcile orphaned ledger entries that have no corresponding on-chain
 * credential (identified by missing credential_pda in the ledger record).
 */

import { createHash } from 'node:crypto';

export interface OpenCheckingRequest {
  subject: string;                    // hex pubkey — receives credential, owns account
  bank_issuer: string;                // hex — bank issuer pubkey (this BPP's signing identity)
  opened_slot: number;
  /** Optional opening deposit, atomic eUSD units. Default 0. */
  opening_deposit_atomic?: number;
}

export interface OpenCheckingResult {
  checking_account_pda: string;
  credential: {
    schema: string;                   // 'account.checking.v1'
    subject: string;
    issuer: string;
    body: {
      account_pda: string;
      holder: string;
      opened_slot: number;
      currency: 'eUSD';
      opening_balance: number;        // atomic units
    };
  };
  fulfillment_uri: string;
}

export interface OpenCheckingDeps {
  /** Re-verify the holder has both required credentials. STUBBED true today (chain gate is authoritative). */
  verifyHolderCredentials: (subject: string, schemas: string[]) => Promise<boolean>;
  /** Issue the account.checking credential on chain (signs IssueCredential). STUBBED. */
  issueCheckingCredential: (cred: OpenCheckingResult['credential']) => Promise<{ tx_signature: string; credential_pda: string }>;
  /** Record CheckingAccount in the local mock ledger. STUBBED. */
  recordCheckingAccount: (pda: string, account: { holder: string; opened_slot: number; opening_balance: number }) => Promise<void>;
  /**
   * FN-191: orphan-ledger reconciliation hook. Called from the
   * `issue_failed` path after `recordCheckingAccount` succeeded but the
   * on-chain `issueCheckingCredential` threw. Mirrors the
   * `flagReconciliation` hook in `offramp.ts` so ops gets a deterministic
   * signal and the eventual GC sweeper can find the orphan.
   *
   * Implementations MUST be idempotent.
   */
  flagReconciliation: (
    account_pda: string,
    holder: string,
    body: { opened_slot: number; opening_balance: number },
  ) => Promise<void>;
}

export class OpenCheckingRejected extends Error {
  constructor(public reason: 'invalid_pubkey' | 'invalid_deposit' | 'credentials_missing' | 'issue_failed' | 'ledger_failed') {
    super('open-checking rejected: ' + reason);
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Credential schemas required by the on-chain Network policy for this BPP. */
export const REQUIRED_SCHEMAS = ['eto.beckn.schema.verified-human.v1', 'eto.beckn.schema.kyc.us-test.v1'];

export async function openChecking(req: OpenCheckingRequest, deps: OpenCheckingDeps): Promise<OpenCheckingResult> {
  if (!HEX64.test(req.subject)) throw new OpenCheckingRejected('invalid_pubkey');
  if (!HEX64.test(req.bank_issuer)) throw new OpenCheckingRejected('invalid_pubkey');
  const opening = req.opening_deposit_atomic ?? 0;
  if (!Number.isInteger(opening) || opening < 0) throw new OpenCheckingRejected('invalid_deposit');

  // Defensive re-check (chain gate is authoritative; this guards against
  // mis-routed requests that bypass the on-chain Init gate).
  const ok = await deps.verifyHolderCredentials(req.subject, REQUIRED_SCHEMAS);
  if (!ok) throw new OpenCheckingRejected('credentials_missing');

  const checking_account_pda = createHash('sha256')
    .update('checking_account')
    .update(Buffer.from(req.subject, 'hex'))
    .update(Buffer.from(BigInt(req.opened_slot).toString(16).padStart(16, '0'), 'hex'))
    .digest('hex');

  const credential: OpenCheckingResult['credential'] = {
    schema: 'account.checking.v1',
    subject: req.subject,
    issuer: req.bank_issuer,
    body: {
      account_pda: checking_account_pda,
      holder: req.subject,
      opened_slot: req.opened_slot,
      currency: 'eUSD',
      opening_balance: opening,
    },
  };

  // Side-effects (atomicity is best-effort in v0; real impl uses 2-phase commit)
  try {
    await deps.recordCheckingAccount(checking_account_pda, {
      holder: req.subject,
      opened_slot: req.opened_slot,
      opening_balance: opening,
    });
  } catch {
    throw new OpenCheckingRejected('ledger_failed');
  }

  try {
    await deps.issueCheckingCredential(credential);
  } catch {
    // FN-191: ledger entry from recordCheckingAccount is now orphaned.
    // Flag for reconciliation BEFORE rethrowing so the eventual GC
    // sweeper has a deterministic handle. flagReconciliation must not
    // throw — if it does, swallow: the primary issue_failed error is
    // what callers act on.
    try {
      await deps.flagReconciliation(checking_account_pda, req.subject, {
        opened_slot: req.opened_slot,
        opening_balance: opening,
      });
    } catch {
      // intentionally swallowed
    }
    throw new OpenCheckingRejected('issue_failed');
  }

  return {
    checking_account_pda,
    credential,
    fulfillment_uri: `eto://checking/${checking_account_pda}`,
  };
}

/** v0 stubs — credential check returns true, others log. */
export const stubs: OpenCheckingDeps = {
  verifyHolderCredentials: async (subject, schemas) => {
    console.log(`[STUB] verifyHolderCredentials subject=${subject.slice(0, 8)} schemas=${schemas.length} → true`);
    return true;
  },
  issueCheckingCredential: async (cred) => {
    const sig = createHash('sha256').update(JSON.stringify(cred)).digest('hex').slice(0, 64);
    const credential_pda = createHash('sha256').update('cred:' + sig).digest('hex');
    console.log(`[STUB] issueCheckingCredential subject=${cred.subject.slice(0, 8)} → tx=${sig.slice(0, 16)}`);
    return { tx_signature: sig, credential_pda };
  },
  flagReconciliation: async (account_pda, holder, _body) => {
    // FN-191 stub — mirrors offramp's flagReconciliation logger.
    console.warn(
      `[STUB] RECONCILE NEEDED open-checking account_pda=${account_pda.slice(0, 12)} holder=${holder.slice(0, 8)} (issue_failed post-recordCheckingAccount)`,
    );
  },
  recordCheckingAccount: async (pda, acc) => {
    console.log(`[STUB] recordCheckingAccount pda=${pda.slice(0, 8)} holder=${acc.holder.slice(0, 8)} opening=${acc.opening_balance}`);
  },
};
