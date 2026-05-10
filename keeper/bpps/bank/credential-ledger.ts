/**
 * FN-105 — shared in-memory ledger for issued bank credentials.
 *
 * Both `issue-card` and `open-checking` need to record a credential to
 * a local ledger BEFORE issuing the on-chain credential, so a future GC
 * sweeper can find orphan ledger entries when the on-chain step fails
 * (see FN-191's `flagReconciliation` hook). v0's stubs were per-handler
 * `console.log` calls; this module gives them a single store so the
 * sweeper has one place to look.
 *
 * Scope (v0): in-memory `Map<pda, Entry>` only. Durable storage and
 * cross-process coordination land in v1 alongside the GC sweeper.
 */
import type { CardDebitCredentialBody } from "./handlers/issue-card.js";

export type LedgerEntryKind = "card.debit.v1" | "account.checking.v1";

export interface CardLedgerEntry {
  kind: "card.debit.v1";
  pda: string;
  holder: string;
  recorded_at_ms: number;
  body: CardDebitCredentialBody;
}

export interface CheckingLedgerEntry {
  kind: "account.checking.v1";
  pda: string;
  holder: string;
  recorded_at_ms: number;
  body: { holder: string; opened_slot: number; opening_balance: number };
}

export type LedgerEntry = CardLedgerEntry | CheckingLedgerEntry;

export interface BankCredentialLedger {
  recordCard(pda: string, body: CardDebitCredentialBody): Promise<void>;
  recordCheckingAccount(
    pda: string,
    account: { holder: string; opened_slot: number; opening_balance: number },
  ): Promise<void>;
  lookup(pda: string): LedgerEntry | undefined;
  list(): readonly LedgerEntry[];
  size(): number;
  clear(): void;
}

export function createInMemoryBankLedger(
  now: () => number = Date.now,
): BankCredentialLedger {
  const entries = new Map<string, LedgerEntry>();
  return {
    async recordCard(pda, body) {
      entries.set(pda, {
        kind: "card.debit.v1",
        pda,
        holder: body.holder,
        recorded_at_ms: now(),
        body,
      });
    },
    async recordCheckingAccount(pda, account) {
      entries.set(pda, {
        kind: "account.checking.v1",
        pda,
        holder: account.holder,
        recorded_at_ms: now(),
        body: account,
      });
    },
    lookup(pda) {
      return entries.get(pda);
    },
    list() {
      return Array.from(entries.values());
    },
    size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Default process-wide ledger instance shared by the v0 stubs in
 * `issue-card.ts` and `open-checking.ts`. Tests should call `clear()`
 * in beforeEach to avoid cross-test bleed.
 */
export const defaultBankLedger: BankCredentialLedger = createInMemoryBankLedger();
