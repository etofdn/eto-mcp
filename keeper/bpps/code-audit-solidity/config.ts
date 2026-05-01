/**
 * Capability tags and runtime config for the `code:audit:solidity` BPP
 * (FN-076). Mirrors FN-075's pattern; adds a `selfCredentialIssuerSet`
 * field that names which issuer(s) (the FN-041 admin endpoint) are
 * accepted for the BPP's own self-asserted skill credential.
 */

import type {
  BppConfig,
  CapabilityTags,
  Pubkey,
} from "../../templates/bpp/index.js";

/**
 * Fixed dev pubkey used as the BPP authority in examples and tests.
 * Real deployments override via `CODE_AUDIT_SOLIDITY_AUTHORITY`.
 */
export const DEV_AUTHORITY_PUBKEY =
  "CodeAuditSolidityBppAuthority11111111111111";

/**
 * Default issuer accepted for the self-asserted
 * `skill.solidity-audit/v1` credential. In real deployments this is
 * overridden via `CODE_AUDIT_SOLIDITY_SELF_ISSUERS`.
 */
export const DEV_SELF_ISSUER_PUBKEY =
  "SkillCertIssuerDevPubkey1111111111111111111";

/** Canonical capability tags advertised by `code:audit:solidity` v1.0.0. */
export const tags: CapabilityTags = {
  domain: "code",
  action: "audit:solidity",
  version: "1.0.0",
  price: { amount: "1.00", currency: "ETO" },
  // TODO(FN-081): once the verified-human credential schema lands,
  // populate this so the BPP rejects anonymous BAPs at Beckn `init`.
  requiredCredentials: [],
  description:
    "Audit one or more Solidity source files for security and " +
    "correctness issues. Wraps slither/mythril when available and " +
    "always runs an LLM auditor for narrative + severity ranking. " +
    "Returns a Markdown audit report and a structured findings list.",
};

/**
 * BPP-config extension: the FN-073 `BppConfig` does not carry a
 * `selfCredentialIssuerSet` field (self-asserted skill credentials are
 * a per-BPP concern, not part of the template surface). We extend it
 * locally so `assertSelfSkillCredential` can read the trusted-issuer
 * list off the same config object.
 */
export interface SolidityAuditBppConfig extends BppConfig {
  readonly selfCredentialIssuerSet: readonly Pubkey[];
}

/** Parse the `CODE_AUDIT_SOLIDITY_SELF_ISSUERS` env into a pubkey list. */
export function parseSelfIssuersEnv(raw: string | undefined): Pubkey[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Resolve the BPP authority from env, falling back to the dev pubkey. */
export function resolveAuthority(): Pubkey {
  return process.env.CODE_AUDIT_SOLIDITY_AUTHORITY ?? DEV_AUTHORITY_PUBKEY;
}

/** Resolve the self-issuer set from env, falling back to the dev issuer. */
export function resolveSelfIssuerSet(): Pubkey[] {
  const fromEnv = parseSelfIssuersEnv(process.env.CODE_AUDIT_SOLIDITY_SELF_ISSUERS);
  return fromEnv.length > 0 ? fromEnv : [DEV_SELF_ISSUER_PUBKEY];
}

/** Build the runtime `SolidityAuditBppConfig`. Reads env at call time. */
export function buildConfig(): SolidityAuditBppConfig {
  return {
    name: "code-audit-solidity-bpp",
    modelId: process.env.KEEPER_MODEL ?? "claude-sonnet-4-6",
    authority: resolveAuthority(),
    capabilityTags: tags,
    requiredBapCredentials: [],
    handlerTimeoutSec: 180,
    selfCredentialIssuerSet: resolveSelfIssuerSet(),
  };
}

/** Canonical config snapshot. Captured once at module load for ergonomics. */
export const config: SolidityAuditBppConfig = buildConfig();
