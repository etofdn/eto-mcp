/**
 * Self-asserted skill credential preflight for the `data:analyze`
 * BPP (FN-201). Mirrors the FN-076 implementation in
 * `keeper/bpps/code-audit-solidity/self-cred.ts` so all reference
 * BPPs share a consistent surface.
 *
 * The BPP advertises that it holds a `skill.data-analyze/v1`
 * credential issued by the FN-041 issuer. At startup we verify this
 * by loading our own AgentCard via an injected `AgentCardLoader` and
 * scanning its `credentials` for a match. If absent we throw a typed
 * `MissingSelfCredentialError` whose message points the operator at
 * the FN-041 admin endpoint to self-issue.
 *
 * Pure function — every seam is injected so tests cover all branches
 * without touching the wire.
 */

import type {
  AgentCardSnapshot,
  Hex32,
  Pubkey,
} from "../../templates/bpp/index.js";

/* -------------------------------------------------------------------------- */
/* AgentCardLoader                                                            */
/* -------------------------------------------------------------------------- */

/** Loader returning the AgentCard snapshot for a given authority. */
export type AgentCardLoader = (
  authority: Pubkey,
) => Promise<AgentCardSnapshot>;

/**
 * In-memory loader for tests / the worked example. Real deployments
 * plug in an RPC-backed loader.
 */
export function inMemoryAgentCardLoader(
  map: ReadonlyMap<Pubkey, AgentCardSnapshot>,
): AgentCardLoader {
  return async (authority: Pubkey) => {
    const card = map.get(authority);
    if (!card) {
      throw new Error(`agent_card_unavailable: ${authority}`);
    }
    return card;
  };
}

/* -------------------------------------------------------------------------- */
/* MissingSelfCredentialError                                                 */
/* -------------------------------------------------------------------------- */

export interface MissingSelfCredentialDetail {
  readonly authority: Pubkey;
  readonly schemaId: Hex32;
  readonly issuerSet: readonly Pubkey[];
  readonly remediation: string;
}

export class MissingSelfCredentialError extends Error {
  public readonly detail: MissingSelfCredentialDetail;

  public constructor(detail: MissingSelfCredentialDetail) {
    super(
      `missing self-asserted skill credential ` +
        `(authority=${detail.authority}, schema=${detail.schemaId.slice(0, 8)}…). ` +
        `Remediation: ${detail.remediation}`,
    );
    this.name = "MissingSelfCredentialError";
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Issuer resolution                                                          */
/* -------------------------------------------------------------------------- */

/** Default dev issuer accepted for `skill.data-analyze/v1`. */
export const DEV_SELF_ISSUER_PUBKEY =
  "SkillCertIssuerDevPubkey1111111111111111111";

/** Parse the `DATA_ANALYZE_SELF_ISSUERS` env into a pubkey list. */
export function parseSelfIssuersEnv(raw: string | undefined): Pubkey[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Resolve the self-issuer set from env, falling back to dev. */
export function resolveSelfIssuerSet(): Pubkey[] {
  const fromEnv = parseSelfIssuersEnv(process.env.DATA_ANALYZE_SELF_ISSUERS);
  return fromEnv.length > 0 ? fromEnv : [DEV_SELF_ISSUER_PUBKEY];
}

/* -------------------------------------------------------------------------- */
/* assertSelfSkillCredential                                                  */
/* -------------------------------------------------------------------------- */

export interface AssertSelfSkillCredentialDeps {
  readonly loadAgentCard: AgentCardLoader;
  readonly ownAuthority: Pubkey;
  readonly issuerSet: readonly Pubkey[];
  readonly schemaId: Hex32;
  /** Wall-clock seconds. */
  readonly nowSec: () => number;
}

/**
 * Loads our own AgentCard and finds a `HeldCredentialSnapshot` whose:
 *  - `schema === schemaId` (plain hex-string equality),
 *  - `issuer` ∈ `issuerSet`,
 *  - `revoked === false`,
 *  - `validFrom === 0` or `validFrom <= now`,
 *  - `validUntil === 0` or `validUntil >= now`.
 *
 * Throws `MissingSelfCredentialError` if no credential matches.
 */
export async function assertSelfSkillCredential(
  deps: AssertSelfSkillCredentialDeps,
): Promise<void> {
  const card = await deps.loadAgentCard(deps.ownAuthority);
  const now = deps.nowSec();
  const issuerSet = new Set(deps.issuerSet);

  for (const cred of card.credentials) {
    if (cred.schema !== deps.schemaId) continue;
    if (!issuerSet.has(cred.issuer)) continue;
    if (cred.revoked) continue;
    if (cred.validFrom !== 0 && cred.validFrom > now) continue;
    if (cred.validUntil !== 0 && cred.validUntil < now) continue;
    return; // match.
  }

  throw new MissingSelfCredentialError({
    authority: deps.ownAuthority,
    schemaId: deps.schemaId,
    issuerSet: deps.issuerSet,
    remediation:
      "POST /issuers/skill-cert/issue (FN-041) with admin token for " +
      `subject=${deps.ownAuthority}, skill=data-analyze`,
  });
}
