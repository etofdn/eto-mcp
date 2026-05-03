/**
 * Authority Inheritance — typed reference predicate for FN-059.
 *
 * Specification:
 * [`docs/authority-inheritance.md`](../../docs/authority-inheritance.md).
 *
 * **Status (FN-059):** spec-only / reference. This module is exported but
 * is NOT yet wired into any MCP tool. The rollout follow-ups
 * (`create_a2a_channel`, `join_swarm`, on-chain `AgentState` extension)
 * will consume `sharesHumanAuthority` / `canInheritTrust` once the on-chain
 * Borsh layout carries `human_authority`.
 *
 * **Trust primitive.** Two agents inherit trust iff both sides' human
 * authority is *verified* (see §2.1) and the `(auth_strategy, sub)` pair
 * matches (see §2.2). Bare `sub` equality is insufficient because two
 * different auth strategies could mint identical `sub` values.
 *
 * **Purity.** This module imports only from
 * [`./agent-identity.js`](./agent-identity.ts) — never from `../tools/`,
 * `../gateway/`, or `../signing/`. It performs no I/O.
 */

import type { AgentIdentity, HumanAuthority } from "./agent-identity.js";

// ---------------------------------------------------------------------------
// Reason codes (mirror docs/authority-inheritance.md §2.3 decision table)
// ---------------------------------------------------------------------------

/**
 * Reason codes returned by {@link canInheritTrust}. The string set is
 * stable wire format — downstream tool implementations surface these
 * verbatim in error messages so users can reason about why inheritance
 * was denied. See spec §2.3.
 */
export type InheritanceReason =
  | "allowed"
  | "missing_human_authority"
  | "unverified_self"
  | "unverified_other"
  | "different_strategy"
  | "different_sub";

// ---------------------------------------------------------------------------
// §2.1 — verification primitive
// ---------------------------------------------------------------------------

/**
 * Internal: is this `human_authority` "verified" for inheritance purposes?
 *
 * Per spec §2.1, only `kind === "thirdweb"` carries a real human
 * attestation. `"dev"`, `"stdio"`, and `"unknown"` MUST NOT inherit even
 * on a `sub` collision. Additionally, a real backend strategy
 * (`siwe | inapp_email | inapp_oauth`) must be present.
 *
 * @see docs/authority-inheritance.md §2.1
 */
function isVerifiedAuthority(
  authority: HumanAuthority | undefined | null,
): boolean {
  if (!authority) return false;
  if (authority.kind !== "thirdweb") return false;
  const strat = authority.auth_strategy;
  return (
    strat === "siwe" ||
    strat === "inapp_email" ||
    strat === "inapp_oauth"
  );
}

/**
 * Internal: does the `human_authority` field structurally exist on this
 * identity? An identity passed in through a partial / on-chain decode path
 * may legitimately omit `human_authority` (e.g. legacy on-chain
 * `AgentState` accounts with `schema_version = 0`). Such identities are
 * treated as `missing_human_authority`, NOT as "unverified", because the
 * caller has expressed no claim at all. See spec §4.2.
 */
function hasAuthorityField(
  identity: AgentIdentity | undefined | null,
): identity is AgentIdentity & { human_authority: HumanAuthority } {
  return Boolean(identity && identity.human_authority);
}

// ---------------------------------------------------------------------------
// §2 — public predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` iff agents `a` and `b` MAY coordinate under the authority
 * inheritance rule (spec §2):
 *
 * 1. both have a `human_authority` field, AND
 * 2. both authorities are *verified* (see {@link isVerifiedAuthority}), AND
 * 3. `auth_strategy` matches on both sides, AND
 * 4. `sub` matches on both sides.
 *
 * This is a pure boolean — for human-readable denial reasons, use
 * {@link canInheritTrust}.
 *
 * The relation is symmetric and reflexive (a verified identity inherits
 * trust with itself). It is NOT transitive across `auth_strategy`
 * boundaries (see §2.2).
 *
 * @see docs/authority-inheritance.md §2
 */
export function sharesHumanAuthority(
  a: AgentIdentity,
  b: AgentIdentity,
): boolean {
  if (!hasAuthorityField(a) || !hasAuthorityField(b)) return false;
  if (!isVerifiedAuthority(a.human_authority)) return false;
  if (!isVerifiedAuthority(b.human_authority)) return false;
  if (a.human_authority.auth_strategy !== b.human_authority.auth_strategy) {
    return false;
  }
  return a.human_authority.sub === b.human_authority.sub;
}

/**
 * Result of {@link canInheritTrust}. `allowed === true` iff
 * `reason === "allowed"`; the two are kept as separate fields so callers
 * can pattern-match on `reason` for telemetry without re-deriving from
 * the boolean.
 */
export interface InheritanceDecision {
  allowed: boolean;
  reason: InheritanceReason;
}

/**
 * Richer wrapper around {@link sharesHumanAuthority} that returns the
 * specific reason for a denial. Used by future tool implementations
 * (`create_a2a_channel`, `join_swarm`) to surface a clear error message
 * to the caller.
 *
 * The reason precedence is fixed and matches the spec §2.3 decision
 * table top-to-bottom:
 *
 * 1. `missing_human_authority` — either side lacks the field entirely
 *    (e.g. legacy on-chain account before `schema_version = 1`).
 * 2. `unverified_self` — `self` is present but not verified.
 * 3. `unverified_other` — `other` is present but not verified.
 * 4. `different_strategy` — both verified, but `auth_strategy` differs.
 * 5. `different_sub` — strategies match, but `sub` differs.
 * 6. `allowed` — all four checks pass.
 *
 * @see docs/authority-inheritance.md §2.3
 */
export function canInheritTrust(
  self: AgentIdentity,
  other: AgentIdentity,
): InheritanceDecision {
  if (!hasAuthorityField(self) || !hasAuthorityField(other)) {
    return { allowed: false, reason: "missing_human_authority" };
  }
  if (!isVerifiedAuthority(self.human_authority)) {
    return { allowed: false, reason: "unverified_self" };
  }
  if (!isVerifiedAuthority(other.human_authority)) {
    return { allowed: false, reason: "unverified_other" };
  }
  if (
    self.human_authority.auth_strategy !==
    other.human_authority.auth_strategy
  ) {
    return { allowed: false, reason: "different_strategy" };
  }
  if (self.human_authority.sub !== other.human_authority.sub) {
    return { allowed: false, reason: "different_sub" };
  }
  return { allowed: true, reason: "allowed" };
}
