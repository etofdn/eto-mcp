/**
 * Runtime configuration for the bank-as-BPP keeper module
 * (FN-096 / T-3.9.1.2).
 *
 * ## Two-tier registration design
 *
 * The BPP template (FN-073) pins capability tags into an AgentCard's
 * `metadata_uri` field as a `data:` URL.  That field has a ≤ 512-byte
 * budget, which is too small to hold five capability descriptions plus
 * pricing and credential requirements.
 *
 * To stay within budget the bank BPP uses an **umbrella tag**:
 *
 *   `{ domain: "bank", action: "catalog", version: "0.1.0" }`
 *
 * The umbrella tag fits in the AgentCard inline budget and tells
 * querying BAPs "this agent runs the bank catalogue".  The **full
 * per-capability BankCatalog** (five capability entries with pricing,
 * credentials, and descriptions) is published separately as a signed
 * `CatalogCommitPayload` via `catalog-publisher.ts`.  This is the
 * escape hatch documented in the template's `MetadataPinner` design.
 *
 * Downstream tasks that need per-capability metadata query the
 * CatalogCommit store rather than the AgentCard's `metadata_uri`.
 *
 * TODO(FN-055): when on-chain `PublishCatalog` lands, the
 * `CatalogCommitRecorder` in `catalog-publisher.ts` becomes an RPC
 * adapter.  The AgentCard umbrella tag shape remains unchanged.
 */

import type { BppConfig, CapabilityTags } from "../../templates/bpp/index.js";
import { buildBankCatalog, type BuildBankCatalogOpts } from "./catalog.js";
import type { BankCatalog, Pubkey } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Dev authority pubkey                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder BPP authority pubkey used in examples and tests.
 *
 * IMPORTANT: This is a TEST-ONLY constant.  Production deployments MUST
 * supply a real authority keypair via the `BANK_BPP_AUTHORITY` environment
 * variable (see `resolveBankAuthority`).
 */
export const DEV_BANK_AUTHORITY_PUBKEY =
  "BankBppDevAuthority1111111111111111111111111";

/**
 * Resolve the bank BPP authority pubkey.
 *
 * Checks `BANK_BPP_AUTHORITY` in the supplied `env` (defaults to
 * `process.env`).  Falls back to `DEV_BANK_AUTHORITY_PUBKEY` if not set.
 *
 * @param env - The environment to read from.  Defaults to `process.env`.
 */
export function resolveBankAuthority(
  env: NodeJS.ProcessEnv = process.env,
): Pubkey {
  return env.BANK_BPP_AUTHORITY ?? DEV_BANK_AUTHORITY_PUBKEY;
}

/* -------------------------------------------------------------------------- */
/* Umbrella capability tags                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The umbrella `CapabilityTags` pinned into the bank AgentCard's
 * `metadata_uri`.
 *
 * A single `{ domain: "bank", action: "catalog" }` entry stays within the
 * AgentCard's ≤ 512-byte `metadata_uri` budget.  The full five-capability
 * `BankCatalog` is published separately as a `CatalogCommitPayload`.
 */
export const BANK_UMBRELLA_TAGS: CapabilityTags = {
  domain: "bank",
  action: "catalog",
  version: "0.1.0",
  price: { amount: "0", currency: "ETO" },
  // TODO(FN-099): add the verified-human + kyc.us-test required
  // credentials once the gate policy lands.
  requiredCredentials: [],
  description:
    "Bank BPP catalogue: checking, savings, fiat-ramp, card, wire.",
};

/* -------------------------------------------------------------------------- */
/* buildConfig                                                                 */
/* -------------------------------------------------------------------------- */

export interface BuildConfigOpts {
  /** Override the BPP authority pubkey. Defaults to `resolveBankAuthority()`. */
  readonly authority?: Pubkey;
  /** Override the model ID. Defaults to `process.env.KEEPER_MODEL ?? "claude-sonnet-4-6"`. */
  readonly modelId?: string;
  /** Override the issuer authority pubkey. Defaults to the same as `authority` for dev. */
  readonly issuerAuthority?: Pubkey;
  /** Optional extra opts forwarded to `buildBankCatalog`. */
  readonly catalogOpts?: Omit<BuildBankCatalogOpts, "bppAuthority" | "issuerAuthority">;
}

/** Return value of `buildConfig`. */
export interface BuildConfigResult {
  readonly config: BppConfig;
  readonly tags: CapabilityTags;
  readonly catalog: BankCatalog;
}

/**
 * Build the template-compatible `BppConfig`, the umbrella `CapabilityTags`,
 * and the full multi-capability `BankCatalog`.
 *
 * The `BppConfig.capabilityTags` carries the **umbrella tag** only — this
 * is what gets pinned into the AgentCard's `metadata_uri`.  The full
 * catalogue is available via the returned `catalog` object and is published
 * separately via `publishBankCatalog` in `catalog-publisher.ts`.
 */
export function buildConfig(opts: BuildConfigOpts = {}): BuildConfigResult {
  const authority = opts.authority ?? resolveBankAuthority();
  const issuerAuthority = opts.issuerAuthority ?? authority;
  const modelId =
    opts.modelId ?? process.env.KEEPER_MODEL ?? "claude-sonnet-4-6";

  const cfg: BppConfig = {
    name: "bank-bpp",
    modelId,
    authority,
    capabilityTags: BANK_UMBRELLA_TAGS,
    requiredBapCredentials: [],
    handlerTimeoutSec: 90,
  };

  const catalog = buildBankCatalog({
    bppAuthority: authority,
    issuerAuthority,
    ...opts.catalogOpts,
  });

  return { config: cfg, tags: BANK_UMBRELLA_TAGS, catalog };
}

/* -------------------------------------------------------------------------- */
/* Module-level singletons (ergonomic imports)                                */
/* -------------------------------------------------------------------------- */

/**
 * Canonical `BppConfig` singleton. Captured once at module load.
 * Mirrors the pattern in `bpps/text-summarize/config.ts`.
 */
export const { config, tags, catalog } = buildConfig();
