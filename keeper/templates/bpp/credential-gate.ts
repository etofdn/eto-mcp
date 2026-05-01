/**
 * Credential-gating hook for BPPs (FN-073, T-2.7.1.1, Step 3).
 *
 * Mirrors the on-chain `satisfies_requirement` check at
 * `src/runtime/src/programs/beckn/instructions/init.rs:346`. Each
 * `RequiredCredential` is satisfied iff the BAP's `AgentCard` carries
 * at least one `HeldCredential` whose
 *
 *   * `schema` matches the requirement,
 *   * `issuer` ∈ `issuerSet` (when non-empty),
 *   * is "active at now" (`!revoked` and within `[validFrom, validUntil]`),
 *   * AND, when `notExpiredWithinSec` is set, has `validUntil` ≥ `now + margin`.
 *
 * Divergences from on-chain `satisfies_requirement`
 * -------------------------------------------------
 * The on-chain check additionally consults the revocation oracle and a
 * `predicate_hash` match. The template-side gate intentionally trusts
 * `revoked` on the snapshot and ignores `predicate_hash`; full parity
 * (oracle lookup + ZK predicate) lands in FN-074 once the oracle
 * client is wired into the Keeper SDK.
 */

import type {
  AgentCardSnapshot,
  HeldCredentialSnapshot,
  Pubkey,
  RequiredCredential,
} from "./types.js";

/** Loader returning the AgentCard snapshot for a given authority pubkey. */
export type AgentCardLoader = (
  pubkey: Pubkey,
) => Promise<AgentCardSnapshot>;

export interface CredentialGateDeps {
  readonly loadAgentCard: AgentCardLoader;
  readonly now: () => number;
}

export type GateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly missing: readonly RequiredCredential[];
      readonly reason: string;
    };

export type CredentialGate = (bapPubkey: Pubkey) => Promise<GateResult>;

/**
 * Construct a credential gate from a list of requirements and a loader.
 * The returned function is safe to call concurrently; each invocation
 * fetches a fresh `AgentCardSnapshot` (no implicit caching — caching is
 * the caller's responsibility, kept that way so revoke events take
 * effect immediately).
 */
export function defaultCredentialGate(
  required: readonly RequiredCredential[],
  deps: CredentialGateDeps,
): CredentialGate {
  return async (bapPubkey: Pubkey): Promise<GateResult> => {
    if (required.length === 0) return { ok: true };

    let card: AgentCardSnapshot;
    try {
      card = await deps.loadAgentCard(bapPubkey);
    } catch (err) {
      return {
        ok: false,
        missing: required,
        reason: `agent_card_unavailable: ${(err as Error).message}`,
      };
    }

    const now = deps.now();
    const missing: RequiredCredential[] = [];
    for (const req of required) {
      if (!findMatchingCredential(card.credentials, req, now)) {
        missing.push(req);
      }
    }
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      missing,
      reason: `missing ${missing.length} required credential(s): ${missing
        .map((m) => m.schema.slice(0, 8))
        .join(",")}`,
    };
  };
}

function findMatchingCredential(
  credentials: readonly HeldCredentialSnapshot[],
  req: RequiredCredential,
  now: number,
): HeldCredentialSnapshot | undefined {
  for (const cred of credentials) {
    if (cred.schema !== req.schema) continue;
    if (req.issuerSet.length > 0 && !req.issuerSet.includes(cred.issuer)) {
      continue;
    }
    if (req.mustBeActive && !isActiveAt(cred, now)) continue;
    if (req.notExpiredWithinSec && req.notExpiredWithinSec > 0) {
      // `validUntil = 0` ⇒ no upper bound, so margin is moot.
      if (cred.validUntil !== 0 && cred.validUntil < now + req.notExpiredWithinSec) {
        continue;
      }
    }
    return cred;
  }
  return undefined;
}

/** Mirror of `HeldCredential::is_active_at` (Rust). */
function isActiveAt(cred: HeldCredentialSnapshot, now: number): boolean {
  if (cred.revoked) return false;
  if (cred.validFrom !== 0 && now < cred.validFrom) return false;
  if (cred.validUntil !== 0 && now > cred.validUntil) return false;
  return true;
}
