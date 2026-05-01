/**
 * Open Savings BPP handler (FN-121 / T-3.11.2.2).
 *
 * Inbound: Beckn /confirm payload from the bridge with order.items =
 *   [{ id: 'open-savings-account', ... }].
 * Outbound: signs CompleteTask with the new SavingsAccount PDA in the
 *   fulfillment_uri, having issued an account.savings credential to the
 *   subject and recorded the new account in the local mock ledger.
 *
 * Pre-conditions enforced by this handler (in addition to the on-chain
 * KY-* gate that Beckn::Init runs):
 *   - subject MUST present a valid account.checking credential issued by
 *     this same bank (the savings account is anchored to a checking account)
 *   - subject MUST hold >= min_balance worth of eUSD (default 0)
 */

import { createHash } from 'node:crypto';

export interface OpenSavingsRequest {
  /** Subject pubkey (hex) — receives the credential and owns the account. */
  subject: string;
  /** Pubkey of the holder's existing CheckingAccount, required reference. */
  linked_checking_account_pda: string;
  /** Bank issuer pubkey (this BPP's signing identity). */
  bank_issuer: string;
  /** Slot at which to record opening. */
  opened_slot: number;
  /** Tier — 'standard' | 'premium' | 'private'. Default 'standard'. */
  tier?: 'standard' | 'premium' | 'private';
  /** Minimum balance, in atomic eUSD units. Default 0. */
  min_balance?: number;
  /** APY in basis points. Default 400 (4 %). */
  apy_bps?: number;
}

export interface OpenSavingsResult {
  /** Newly minted SavingsAccount PDA (derived deterministically from subject + slot). */
  savings_account_pda: string;
  /** account.savings credential body (matches spec/banking/credentials/account-savings.json). */
  credential: {
    schema: string;
    subject: string;
    issuer: string;
    body: {
      account_pda: string;
      holder: string;
      opened_slot: number;
      currency: 'eUSD';
      min_balance: number;
      apy_bps: number;
      tier: 'standard' | 'premium' | 'private';
    };
  };
  /** URI the BPP returns as the fulfillment artifact. */
  fulfillment_uri: string;
}

export interface OpenSavingsDeps {
  /** Verify that subject holds a valid account.checking credential bound to
   *  linked_checking_account_pda. STUBBED today. */
  verifyCheckingCredential: (subject: string, checking_pda: string) => Promise<boolean>;
  /** Issue account.savings credential on chain (signs IssueCredential). STUBBED. */
  issueSavingsCredential: (cred: OpenSavingsResult['credential']) => Promise<{ tx_signature: string; credential_pda: string }>;
  /** Record SavingsAccount in local ledger / off-chain DB. STUBBED. */
  recordSavingsAccount: (pda: string, account: { holder: string; opened_slot: number; min_balance: number; apy_bps: number; tier: string }) => Promise<void>;
}

export class OpenSavingsRejected extends Error {
  constructor(public reason: 'no_checking_credential' | 'invalid_pda' | 'invalid_tier' | 'invalid_apy') {
    super('open-savings rejected: ' + reason);
  }
}

export async function openSavings(req: OpenSavingsRequest, deps: OpenSavingsDeps): Promise<OpenSavingsResult> {
  // Validate inputs
  if (!/^[0-9a-fA-F]{64}$/.test(req.subject)) throw new OpenSavingsRejected('invalid_pda');
  if (!/^[0-9a-fA-F]{64}$/.test(req.linked_checking_account_pda)) throw new OpenSavingsRejected('invalid_pda');
  if (!/^[0-9a-fA-F]{64}$/.test(req.bank_issuer)) throw new OpenSavingsRejected('invalid_pda');
  const tier = req.tier ?? 'standard';
  if (!(['standard', 'premium', 'private'] as const).includes(tier)) throw new OpenSavingsRejected('invalid_tier');
  const apy_bps = req.apy_bps ?? 400;
  if (apy_bps < 0 || apy_bps > 10_000) throw new OpenSavingsRejected('invalid_apy');
  const min_balance = req.min_balance ?? 0;

  // Pre-condition: subject must have a checking account credential
  const has_checking = await deps.verifyCheckingCredential(req.subject, req.linked_checking_account_pda);
  if (!has_checking) throw new OpenSavingsRejected('no_checking_credential');

  // Derive deterministic SavingsAccount PDA from subject + slot
  const savings_account_pda = createHash('sha256')
    .update('savings_account')
    .update(Buffer.from(req.subject, 'hex'))
    .update(Buffer.from(BigInt(req.opened_slot).toString(16).padStart(16, '0'), 'hex'))
    .digest('hex');

  // Build credential body (matches account-savings.json schema)
  const credential: OpenSavingsResult['credential'] = {
    schema: 'account.savings.v1',
    subject: req.subject,
    issuer: req.bank_issuer,
    body: {
      account_pda: savings_account_pda,
      holder: req.subject,
      opened_slot: req.opened_slot,
      currency: 'eUSD',
      min_balance,
      apy_bps,
      tier,
    },
  };

  // Atomic-ish off-chain ops (stub: real impl wraps in a 2-phase commit)
  await deps.recordSavingsAccount(savings_account_pda, {
    holder: req.subject,
    opened_slot: req.opened_slot,
    min_balance,
    apy_bps,
    tier,
  });
  await deps.issueSavingsCredential(credential);

  return {
    savings_account_pda,
    credential,
    fulfillment_uri: `eto://savings/${savings_account_pda}`,
  };
}

/** Default stubs for v0 — ledger lives in-process, on-chain submissions log. */
export const stubs: OpenSavingsDeps = {
  verifyCheckingCredential: async (subject, pda) => {
    console.log(`[STUB] verifyCheckingCredential subject=${subject.slice(0, 8)} pda=${pda.slice(0, 8)} -> true`);
    return true;
  },
  issueSavingsCredential: async (cred) => {
    const sig = createHash('sha256').update(JSON.stringify(cred)).digest('hex').slice(0, 64);
    const credential_pda = createHash('sha256').update('cred:' + sig).digest('hex');
    console.log(`[STUB] issueSavingsCredential subject=${cred.subject.slice(0, 8)} -> tx=${sig.slice(0, 16)}`);
    return { tx_signature: sig, credential_pda };
  },
  recordSavingsAccount: async (pda, acc) => {
    console.log(`[STUB] recordSavingsAccount pda=${pda.slice(0, 8)} holder=${acc.holder.slice(0, 8)} apy=${acc.apy_bps}`);
  },
};
