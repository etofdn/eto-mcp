// `bank.fiat-ramp-test` mock issuer (T-1.4.2.3, FN-042).
//
// Mints a `bank.fiat-ramp-test` credential when the mock bank's BPP
// reports that a checking account has been opened for a holder. v0
// stubs the bank end-to-end so the *issuer* is also a stub: there is
// no upstream verification step — the bridge accepts the
// (checkingAccountId, agentCardPubkey) tuple at face value, dedupes
// on `checkingAccountId`, and submits an `IssueCredential` tx under
// the `bank.fiat-ramp-test` schema.
//
// The acceptance criterion has two halves:
//
//   1. *Issuance ties to a mock checking-account-id.* The bridge
//      stores a `(checkingAccountId → credentialPda)` mapping, and
//      the off-chain VC envelope (whose JCS-canonical hash becomes
//      the on-chain `claim_hash`) embeds `checkingAccountId` as a
//      first-class subject field. So given a credential PDA you can
//      always trace it back to the originating mock account, and
//      vice-versa.
//
//   2. *Revocable.* `revokeBankFiatRampTest({ checkingAccountId })`
//      looks up the row, calls the `RevokeCredential` instruction
//      against the discovered PDA, and persists the revoked flag so
//      a subsequent revoke is a no-op (idempotent). The on-chain
//      `Credential.revoked` bit is what relying parties actually
//      gate on; the bridge's row is only a lookup index.
//
// The module is shaped like the Civic / Worldcoin adapters
// (T-1.4.1.2 / T-1.4.1.3) so a single gateway boot can wire all
// three with the same chain client and pinner.

import { createHash } from "node:crypto";

import {
  BankMockIssueError,
  BankMockIssueRequest,
  BankMockIssueResponse,
  BankMockIssuerDeps,
  BankMockRevokeRequest,
  BankMockRevokeResponse,
  BankMockRow,
} from "./bank-mock.types.js";

export {
  BankMockIssueError,
} from "./bank-mock.types.js";
export type {
  BankMockIssueRequest,
  BankMockIssueResponse,
  BankMockIssuerDeps,
  BankMockIssueErrorKind,
  BankMockRevokeRequest,
  BankMockRevokeResponse,
  BankMockRow,
  BankMockStore,
  IssueCredentialClient,
  RevokeCredentialClient,
  VcPinner,
  SlotClock,
} from "./bank-mock.types.js";

// -- Domain constants -------------------------------------------------

/**
 * On-chain schema id for `bank.fiat-ramp-test`. Derived as
 * `sha256("eto.beckn.schema.bank.fiat-ramp-test.v1")` so it shares
 * the `eto.beckn.schema.*` domain prefix used by the verified-human
 * schema (`spec/issuers/worldcoin-integration.md` §7).
 *
 * Exported so issuer-network admin tooling and tests can assert this
 * id appears in `IssuerNetwork.issuable_schemas` for the mock bank.
 */
export const BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX = sha256Hex(
  "eto.beckn.schema.bank.fiat-ramp-test.v1",
);

/**
 * `valid_until_slot = 0` means "no upper bound" per L1 §5.1; explicit
 * revocation is performed via `revokeBankFiatRampTest`.
 */
const VALID_UNTIL_NO_BOUND = 0n;

// -- Public entry points ----------------------------------------------

/**
 * Issue a `bank.fiat-ramp-test` credential bound to a mock
 * checking-account-id.
 *
 * Idempotent on `(checkingAccountId, agentCardPubkey)` repeats; throws
 * `BankMockIssueError("binding_conflict")` if the same
 * `checkingAccountId` was previously bound to a *different*
 * `agentCardPubkey`.
 */
export async function issueBankFiatRampTest(
  deps: BankMockIssuerDeps,
  request: BankMockIssueRequest,
): Promise<BankMockIssueResponse> {
  const { checkingAccountId, agentCardPubkey } = request;
  if (checkingAccountId.length === 0) {
    throw new BankMockIssueError(
      "invalid_request",
      "checkingAccountId is empty",
      "empty_checking_account_id",
    );
  }
  if (agentCardPubkey.length === 0) {
    throw new BankMockIssueError(
      "invalid_request",
      "agentCardPubkey is empty",
      "empty_card",
    );
  }

  // Step 1 — consult the store.
  const existing = await deps.store.get(checkingAccountId);
  if (existing !== undefined) {
    if (existing.agentCardPubkey !== agentCardPubkey) {
      throw new BankMockIssueError(
        "binding_conflict",
        "checking-account already bound to a different AgentCard",
        `bound_card=${existing.agentCardPubkey}`,
      );
    }
    // Same (id, card) pair → idempotent re-emit. Whether the row is
    // currently revoked or not is irrelevant for idempotency: callers
    // who want to re-issue after revocation must use a fresh
    // checkingAccountId (revocation is monotonic by construction).
    return {
      status: "idempotent",
      credentialPda: existing.credentialPda,
      txSignature: existing.txSignature,
      claimUri: existing.claimUri,
      checkingAccountId,
    };
  }

  // Step 2 — build VC, pin, submit on-chain IssueCredential.
  const slot = await deps.clock.currentSlot();
  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();

  const vc = buildBankFiatRampTestVc({
    agentCardPubkey,
    issuerAuthorityPubkey: deps.issuerAuthorityPubkey,
    checkingAccountId,
    issuanceDate: new Date(nowUnix * 1000).toISOString(),
  });
  const claimJcs = jcsCanonicalize(vc);
  const claimHashHex = sha256Hex(claimJcs);

  const { uri: claimUri } = await deps.pinner.pin(claimJcs);

  let chainResult;
  try {
    chainResult = await deps.chain.issueCredential({
      subjectAgentCardPubkey: agentCardPubkey,
      schemaIdHex: BANK_FIAT_RAMP_TEST_SCHEMA_ID_HEX,
      claimUri,
      claimHashHex,
      validFromSlot: slot,
      validUntilSlot: VALID_UNTIL_NO_BOUND,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BankMockIssueError(
      "chain_failed",
      `IssueCredential tx failed: ${message}`,
    );
  }

  // Step 3 — persist the row only after a successful chain tx so a
  // failed tx never poisons future retries with a stale binding.
  const winner = await deps.store.putIfAbsent({
    checkingAccountId,
    agentCardPubkey,
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    issuedAtUnix: nowUnix,
    revoked: false,
  });

  if (winner.agentCardPubkey !== agentCardPubkey) {
    // A concurrent request for the same checkingAccountId from a
    // different card landed first. Our chain tx already minted a
    // PDA against *our* card — the bridge's invariant is "one mock
    // checking-account ↔ one AgentCard", so surface the conflict.
    throw new BankMockIssueError(
      "binding_conflict",
      "checking-account was bound to a different AgentCard during issuance",
      `bound_card=${winner.agentCardPubkey}`,
    );
  }

  if (winner.credentialPda !== chainResult.credentialPda) {
    // Same card raced with itself; the earlier row is authoritative.
    return {
      status: "idempotent",
      credentialPda: winner.credentialPda,
      txSignature: winner.txSignature,
      claimUri: winner.claimUri,
      checkingAccountId,
    };
  }

  return {
    status: "issued",
    credentialPda: chainResult.credentialPda,
    txSignature: chainResult.txSignature,
    claimUri,
    claimHashHex,
    checkingAccountId,
  };
}

/**
 * Revoke a previously-issued `bank.fiat-ramp-test` credential by its
 * mock checking-account-id.
 *
 * Looks the credential PDA up via the bridge's store, submits a
 * `RevokeCredential` instruction, and persists the revoked flag.
 * Idempotent: a second call returns `status: "already_revoked"` and
 * does not re-submit a chain tx.
 */
export async function revokeBankFiatRampTest(
  deps: BankMockIssuerDeps,
  request: BankMockRevokeRequest,
): Promise<BankMockRevokeResponse> {
  const { checkingAccountId } = request;
  if (checkingAccountId.length === 0) {
    throw new BankMockIssueError(
      "invalid_request",
      "checkingAccountId is empty",
      "empty_checking_account_id",
    );
  }

  const row = await deps.store.get(checkingAccountId);
  if (row === undefined) {
    throw new BankMockIssueError(
      "not_found",
      "no credential issued for this checking-account-id",
      checkingAccountId,
    );
  }

  if (row.revoked) {
    // Idempotent revoke. We always have a `revokeTxSignature` here
    // because `markRevoked` is only callable after a successful
    // chain revoke.
    return {
      status: "already_revoked",
      credentialPda: row.credentialPda,
      revokeTxSignature: row.revokeTxSignature ?? "",
      checkingAccountId,
    };
  }

  let revokeResult;
  try {
    revokeResult = await deps.revoker.revokeCredential({
      credentialPda: row.credentialPda,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BankMockIssueError(
      "chain_failed",
      `RevokeCredential tx failed: ${message}`,
    );
  }

  const nowUnix = (deps.nowUnix ?? defaultNowUnix)();
  await deps.store.markRevoked({
    checkingAccountId,
    revokedAtUnix: nowUnix,
    revokeTxSignature: revokeResult.txSignature,
  });

  return {
    status: "revoked",
    credentialPda: row.credentialPda,
    revokeTxSignature: revokeResult.txSignature,
    checkingAccountId,
  };
}

// -- Helpers ----------------------------------------------------------

interface VcInput {
  agentCardPubkey: string;
  issuerAuthorityPubkey: string;
  checkingAccountId: string;
  issuanceDate: string;
}

/**
 * Build the off-chain VC envelope. Subject ties the credential to the
 * mock checking-account-id explicitly so a relying party (or an
 * auditor) can recover the binding from the credential alone, without
 * trusting the bridge's index.
 *
 * The `proof` block is intentionally absent — production signs after
 * JCS canonicalization; for v0 + tests the unsigned envelope is
 * sufficient and `claim_hash` is the SHA-256 of the JCS bytes of
 * exactly this object.
 */
export function buildBankFiatRampTestVc(
  input: VcInput,
): Record<string, unknown> {
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.eto.dev/bank/fiat-ramp-test/v1",
    ],
    type: ["VerifiableCredential", "BankFiatRampTestCredential"],
    issuer: "did:eto:bank-mock",
    issuanceDate: input.issuanceDate,
    credentialSubject: {
      id: `did:eto:agentcard:${input.agentCardPubkey}`,
      checkingAccountId: input.checkingAccountId,
      bankBindingType: "checking-account",
      mockIssuer: true,
    },
    issuerAuthority: input.issuerAuthorityPubkey,
  };
}

// JCS (RFC 8785) canonicalization was originally inlined here; FN-084
// became the fourth caller (audit-trail + travel-rule signing) so the
// implementation now lives in `src/utils/jcs.ts`. The re-export below
// keeps `jcsCanonicalize` part of this module's public surface for
// existing downstream callers (issuer modules, tests).
import { jcsCanonicalize } from "../utils/jcs.js";
export { jcsCanonicalize };

/**
 * Compute the SHA-256 digest of a UTF-8 string and return it as a
 * lowercase 64-character hex string. Exported so downstream issuer
 * modules (`bank.ts`, etc.) can share this helper without re-declaring
 * it (DRY + single implementation for the `claim_hash` convention).
 *
 * Added as an additive export in FN-097 — no behaviour change.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function defaultNowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Reference in-memory store for devnet/tests. Production wires the
 * bridge to a durable KV (Postgres / Sqlite) but the contract here
 * is the same.
 */
export class InMemoryBankMockStore {
  private readonly rows = new Map<string, BankMockRow>();

  public async get(checkingAccountId: string): Promise<BankMockRow | undefined> {
    return this.rows.get(checkingAccountId);
  }

  public async putIfAbsent(row: BankMockRow): Promise<BankMockRow> {
    const existing = this.rows.get(row.checkingAccountId);
    if (existing) return existing;
    this.rows.set(row.checkingAccountId, row);
    return row;
  }

  public async markRevoked(input: {
    readonly checkingAccountId: string;
    readonly revokedAtUnix: number;
    readonly revokeTxSignature: string;
  }): Promise<BankMockRow> {
    const existing = this.rows.get(input.checkingAccountId);
    if (existing === undefined) {
      throw new Error(
        `markRevoked: unknown checkingAccountId=${input.checkingAccountId}`,
      );
    }
    if (existing.revoked) {
      return existing;
    }
    const updated: BankMockRow = {
      ...existing,
      revoked: true,
      revokedAtUnix: input.revokedAtUnix,
      revokeTxSignature: input.revokeTxSignature,
    };
    this.rows.set(input.checkingAccountId, updated);
    return updated;
  }
}
