/**
 * Composable BAP credential gating helpers (FN-074, T-2.7.1.2).
 *
 * Layered on top of the list-based {@link CredentialGate} contract
 * shipped in FN-073 (`keeper/templates/bpp/credential-gate.ts`). The
 * primitive here is `requireCred(schema, predicate?, opts?)` — a tiny
 * synchronous middleware that evaluates a single credential
 * requirement against a pre-loaded {@link AgentCardSnapshot}. The
 * combinator {@link composeGates} aggregates a list of middlewares
 * into a `CredentialGate` ready to be passed as `deps.gate` to
 * `runBpp`.
 *
 * Composition model
 * -----------------
 * ```ts
 * const gate = composeGates(
 *   [requireCred(VERIFIED_HUMAN_SCHEMA_ID)],
 *   { loadAgentCard, now: () => Math.floor(Date.now() / 1000) },
 * );
 * await runBpp(config, handler, { eventSource, chain, gate, logger });
 * ```
 *
 * When to use which
 * -----------------
 * - **`defaultCredentialGate(required[], deps)`** (FN-073) — best when
 *   a BPP's gating is fully describable as a list of
 *   `RequiredCredential`s (schema + issuer set + active-window). The
 *   list ships in `BppConfig.requiredBapCredentials`, is also pinned
 *   into `CapabilityTags.requiredCredentials`, and matches the
 *   on-chain `RequirementSpec` 1:1.
 * - **`composeGates([requireCred(...), ...], deps)`** (this module) —
 *   best when the predicate is more interesting than schema/issuer
 *   ("verified-human cred whose nullifier is non-zero", "skill-cert
 *   whose attributes include `code:audit:solidity`"). Authors can mix
 *   raw `GateMiddleware` callbacks with `requireCred` results; the
 *   `meta` carried by `requireCred` lets `composeGates` populate
 *   `GateResult.missing` for downstream diagnostics.
 *
 * Parity with `defaultCredentialGate`
 * -----------------------------------
 * `requireCred`'s schema / issuer-set / active-window / margin checks
 * mirror `defaultCredentialGate`'s semantics exactly (see
 * `keeper/templates/bpp/credential-gate.ts`). The added knob is the
 * synchronous `predicate` callback; everything else collapses to the
 * same on-chain-equivalent behavior. The on-chain
 * `satisfies_requirement` (`init.rs:346`) additionally consults the
 * revocation oracle and a `predicate_hash` ZK check; both are out of
 * scope here and remain the integrator's responsibility (the
 * `predicate` callback is the natural seam for pre-verified ZK
 * outputs).
 */

import type {
  AgentCardSnapshot,
  HeldCredentialSnapshot,
  Hex32,
  Pubkey,
  RequiredCredential,
} from "../templates/bpp/types.js";
import type {
  AgentCardLoader,
  CredentialGate,
  GateResult,
} from "../templates/bpp/credential-gate.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/** Context passed to predicates and middlewares (deterministic `now`). */
export interface GateMiddlewareCtx {
  readonly now: number;
  readonly bapPubkey: Pubkey;
}

/**
 * Synchronous predicate run against each schema-matching cred. Return
 * `true` to accept the credential, `false` to reject. Predicates must
 * be pure and cheap; heavy I/O belongs in a custom `GateMiddleware`.
 */
export type CredPredicate = (
  cred: HeldCredentialSnapshot,
  ctx: GateMiddlewareCtx,
) => boolean;

export type GateMiddlewareResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * A single gating step. Receives an already-loaded
 * `AgentCardSnapshot` so composition stays cheap and synchronous.
 *
 * Middlewares MAY attach a `meta: RequiredCredential` so
 * {@link composeGates} can populate `GateResult.missing` on denial.
 * `meta` is strictly informational — middleware logic must not
 * depend on it.
 */
export type GateMiddleware = (
  card: AgentCardSnapshot,
  ctx: GateMiddlewareCtx,
) => GateMiddlewareResult;

/** A `GateMiddleware` produced by {@link requireCred} (carries meta). */
export type GateMiddlewareWithMeta = GateMiddleware & {
  readonly meta: RequiredCredential;
};

/** Options accepted by {@link requireCred}. */
export interface RequireCredOpts {
  /** Default `true`. When `true`, revoked / out-of-window creds are rejected. */
  readonly mustBeActive?: boolean;
  /**
   * If set, additionally rejects credentials whose `validUntil` is
   * within this many seconds of `ctx.now`. `0` / undefined ⇒ no
   * margin enforced. Mirrors `RequiredCredential.notExpiredWithinSec`.
   */
  readonly notExpiredWithinSec?: number;
  /** Allowed issuer pubkeys. Empty / undefined ⇒ any issuer permitted. */
  readonly issuerSet?: readonly Pubkey[];
}

/* -------------------------------------------------------------------------- */
/* requireCred                                                                */
/* -------------------------------------------------------------------------- */

type NearMiss =
  | "not_found"
  | "wrong_issuer"
  | "inactive"
  | "expiring"
  | "predicate_rejected";

const NEAR_MISS_RANK: Record<NearMiss, number> = {
  not_found: 0,
  wrong_issuer: 1,
  inactive: 2,
  expiring: 3,
  predicate_rejected: 4,
};

/**
 * Build a {@link GateMiddleware} that requires the BAP's AgentCard to
 * carry at least one credential matching `schema`, the (optional)
 * `predicate`, and the (optional) `opts` filters.
 *
 * Failure reasons surface the most-specific near-miss across all
 * same-schema credentials (e.g. if a same-schema cred exists but
 * fails the predicate, the reason is `predicate_rejected`, not
 * `not_found`). The reason format is
 * `missing_cred:<schema-prefix>:<why>` where `<why>` is one of
 * `not_found | wrong_issuer | inactive | expiring | predicate_rejected`.
 *
 * The returned middleware exposes a `meta: RequiredCredential` so
 * {@link composeGates} can populate `GateResult.missing` on denial.
 */
export function requireCred(
  schema: Hex32,
  predicate?: CredPredicate,
  opts: RequireCredOpts = {},
): GateMiddlewareWithMeta {
  const mustBeActive = opts.mustBeActive ?? true;
  const notExpiredWithinSec = opts.notExpiredWithinSec ?? 0;
  const issuerSet: readonly Pubkey[] = opts.issuerSet ?? [];

  const meta: RequiredCredential = {
    schema,
    issuerSet,
    mustBeActive,
    ...(notExpiredWithinSec > 0 ? { notExpiredWithinSec } : {}),
  };

  const fn: GateMiddleware = (card, ctx) => {
    let best: NearMiss = "not_found";
    let bestRank = NEAR_MISS_RANK.not_found;

    const note = (m: NearMiss) => {
      const r = NEAR_MISS_RANK[m];
      if (r > bestRank) {
        best = m;
        bestRank = r;
      }
    };

    for (const cred of card.credentials) {
      if (cred.schema !== schema) continue;

      // Stage 1 — issuer filter.
      if (issuerSet.length > 0 && !issuerSet.includes(cred.issuer)) {
        note("wrong_issuer");
        continue;
      }
      // Stage 2 — active window.
      if (mustBeActive && !isActiveAt(cred, ctx.now)) {
        note("inactive");
        continue;
      }
      // Stage 3 — margin.
      if (
        notExpiredWithinSec > 0 &&
        cred.validUntil !== 0 &&
        cred.validUntil < ctx.now + notExpiredWithinSec
      ) {
        note("expiring");
        continue;
      }
      // Stage 4 — predicate.
      if (predicate && !predicate(cred, ctx)) {
        note("predicate_rejected");
        continue;
      }
      return { ok: true };
    }

    return {
      ok: false,
      reason: `missing_cred:${schema.slice(0, 8)}:${best}`,
    };
  };

  return Object.assign(fn, { meta });
}

/* -------------------------------------------------------------------------- */
/* composeGates                                                               */
/* -------------------------------------------------------------------------- */

export interface ComposeGatesDeps {
  readonly loadAgentCard: AgentCardLoader;
  readonly now: () => number;
}

export interface ComposeGatesOpts {
  /**
   * - `"all"` (default) — run every middleware and aggregate all
   *   failures into a single denial. Best for diagnostics.
   * - `"first-fail"` — short-circuit on the first denial; later
   *   middlewares are not invoked. Best when downstream middlewares
   *   are expensive or have side effects.
   */
  readonly mode?: "all" | "first-fail";
}

/**
 * Compose middlewares into a {@link CredentialGate} suitable for
 * `runBpp({ ..., gate })`. Loads the BAP `AgentCardSnapshot` once per
 * gate call. An empty middleware list always resolves to `{ ok: true }`
 * (parity with `defaultCredentialGate` when `required.length === 0`).
 *
 * If `loadAgentCard` throws, the gate denies with reason
 * `agent_card_unavailable: <msg>` and never invokes any middleware
 * (parity with `defaultCredentialGate`).
 */
export function composeGates(
  middlewares: readonly GateMiddleware[],
  deps: ComposeGatesDeps,
  opts: ComposeGatesOpts = {},
): CredentialGate {
  const mode = opts.mode ?? "all";

  return async (bapPubkey: Pubkey): Promise<GateResult> => {
    if (middlewares.length === 0) return { ok: true };

    let card: AgentCardSnapshot;
    try {
      card = await deps.loadAgentCard(bapPubkey);
    } catch (err) {
      return {
        ok: false,
        missing: [],
        reason: `agent_card_unavailable: ${(err as Error).message}`,
      };
    }

    const ctx: GateMiddlewareCtx = { now: deps.now(), bapPubkey };
    const reasons: string[] = [];
    const missing: RequiredCredential[] = [];

    for (const mw of middlewares) {
      const res = mw(card, ctx);
      if (res.ok) continue;
      reasons.push(res.reason);
      const m = (mw as Partial<GateMiddlewareWithMeta>).meta;
      if (m) missing.push(m);
      if (mode === "first-fail") break;
    }

    if (reasons.length === 0) return { ok: true };
    return { ok: false, missing, reason: reasons.join(",") };
  };
}

/* -------------------------------------------------------------------------- */
/* Internal — duplicated from FN-073 to keep that contract frozen.            */
/* -------------------------------------------------------------------------- */

/** Mirror of `HeldCredential::is_active_at` (Rust). */
function isActiveAt(cred: HeldCredentialSnapshot, now: number): boolean {
  if (cred.revoked) return false;
  if (cred.validFrom !== 0 && now < cred.validFrom) return false;
  if (cred.validUntil !== 0 && now > cred.validUntil) return false;
  return true;
}
