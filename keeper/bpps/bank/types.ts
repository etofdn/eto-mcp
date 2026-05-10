/**
 * Types for the bank-as-BPP keeper module (FN-096 / T-3.9.1.2).
 *
 * The bank BPP advertises five capability tags — bank.checking,
 * bank.savings, bank.fiat-ramp, bank.card, bank.wire — inside a
 * single multi-capability `BankCatalog`.  Unlike the single-capability
 * reference BPPs (FN-075–079), the bank registers an umbrella
 * `BppConfig` whose `capabilityTags` carries a single `{ domain:
 * "bank", action: "catalog" }` tag (≤ 512-byte AgentCard budget);
 * the full per-capability catalogue is published separately as a
 * `CatalogCommitPayload` (see `catalog-publisher.ts`).
 *
 * Concrete handler logic for each capability is deliberately
 * **out of scope** for FN-096 — stubs return
 * `{ status: "failure", reason: "not_implemented: …" }`.  Downstream
 * tasks fill in the real logic:
 *
 *   bank.checking  → FN-097 issuer service, FN-115 open-checking flow
 *   bank.savings   → FN-121 open-savings flow
 *   bank.fiat-ramp → FN-107 onramp / FN-145 offramp handlers
 *   bank.card      → FN-125 issue-card flow
 *   bank.wire      → FN-119 wire transfer flow
 */

import { z } from "zod";
import {
  zCapabilityTags,
  zRequiredCredential,
  type CapabilityTags,
  type Currency,
  type Pubkey,
} from "../../templates/bpp/types.js";

// Re-export types consumed downstream
export type { Pubkey, Currency };

/* -------------------------------------------------------------------------- */
/* Capability key union                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The five bank capability keys, in canonical spec order.
 * The order here is intentionally preserved in `BankCatalog.capabilities`.
 */
export type BankCapabilityKey =
  | "bank.checking"
  | "bank.savings"
  | "bank.fiat-ramp"
  | "bank.card"
  | "bank.wire";

/* -------------------------------------------------------------------------- */
/* Per-capability capability tags                                              */
/* -------------------------------------------------------------------------- */

/**
 * Capability tags for a single bank capability.
 *
 * Extends `CapabilityTags` with a strict `domain: "bank"` literal and
 * a `capabilityKey` discriminator so that type narrowing works without
 * string parsing.
 */
export interface BankCapability extends CapabilityTags {
  readonly domain: "bank";
  /**
   * The action within the bank domain (e.g. `"checking"`, `"savings"`).
   * Note: this is the **action** field in `CapabilityTags`, not the full
   * `BankCapabilityKey` (which is `"bank.<action>"`).
   */
  readonly action: string;
  /** The full capability key, e.g. `"bank.checking"`. */
  readonly capabilityKey: BankCapabilityKey;
}

/* -------------------------------------------------------------------------- */
/* Placeholder IO interfaces                                                   */
/* -------------------------------------------------------------------------- */

// NOTE: Each interface below is a placeholder. The real request/response
// shapes will be defined by the downstream tasks listed in the comments.
// Use `unknown`-compatible shapes here so the stub handler can accept any
// input without compile-time validation (validation is the responsibility
// of the real handlers).

/**
 * Input for `bank.checking` capability.
 * TODO(FN-097, FN-115): Replace with the real OpenCheckingInput type.
 */
export interface OpenCheckingInput {
  /** Agent (BAP) public key requesting account open. */
  readonly agentPubkey?: string;
  /** Arbitrary extra fields — real schema defined in FN-097/FN-115. */
  readonly [k: string]: unknown;
}

/**
 * Output for `bank.checking` capability.
 * TODO(FN-097, FN-115): Replace with the real OpenCheckingOutput type.
 */
export interface OpenCheckingOutput {
  readonly checkingAccountId?: string;
  readonly [k: string]: unknown;
}

/**
 * Input for `bank.savings` capability.
 * TODO(FN-121): Replace with the real OpenSavingsInput type.
 */
export interface OpenSavingsInput {
  readonly agentPubkey?: string;
  readonly [k: string]: unknown;
}

/**
 * Output for `bank.savings` capability.
 * TODO(FN-121): Replace with the real OpenSavingsOutput type.
 */
export interface OpenSavingsOutput {
  readonly savingsAccountId?: string;
  readonly [k: string]: unknown;
}

/**
 * Input for `bank.fiat-ramp` capability.
 * TODO(FN-107, FN-145): Replace with the real FiatRampInput type.
 */
export interface FiatRampInput {
  /** "deposit" (fiat → eUSD) or "withdraw" (eUSD → fiat). */
  readonly direction?: "deposit" | "withdraw";
  readonly [k: string]: unknown;
}

/**
 * Output for `bank.fiat-ramp` capability.
 * TODO(FN-107, FN-145): Replace with the real FiatRampOutput type.
 */
export interface FiatRampOutput {
  readonly rampEventId?: string;
  readonly [k: string]: unknown;
}

/**
 * Input for `bank.card` capability.
 * TODO(FN-125): Replace with the real CardInput type.
 */
export interface CardInput {
  readonly agentPubkey?: string;
  readonly [k: string]: unknown;
}

/**
 * Output for `bank.card` capability.
 * TODO(FN-125): Replace with the real CardOutput type.
 */
export interface CardOutput {
  readonly cardId?: string;
  readonly [k: string]: unknown;
}

/**
 * Input for `bank.wire` capability.
 * TODO(FN-119): Replace with the real WireInput type.
 */
export interface WireInput {
  readonly amountCents?: number;
  readonly [k: string]: unknown;
}

/**
 * Output for `bank.wire` capability.
 * TODO(FN-119): Replace with the real WireOutput type.
 */
export interface WireOutput {
  readonly wireTransferId?: string;
  readonly [k: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* BankCatalog                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Immutable multi-capability catalogue for the bank BPP.
 *
 * This is the canonical JSON artefact that is hashed and published as
 * a `CatalogCommitPayload` on-chain (FN-055 / FN-085).  The `capabilities`
 * array MUST contain exactly five entries in the spec order:
 *   [0] bank.checking
 *   [1] bank.savings
 *   [2] bank.fiat-ramp
 *   [3] bank.card
 *   [4] bank.wire
 */
export interface BankCatalog {
  /** Human-readable catalogue schema version. */
  readonly version: string;
  /** IssuerNetwork label: `BANK_NETWORK_LABEL` from FN-095. */
  readonly networkLabel: string;
  /** `computeBankNetworkId(networkLabel)` as lowercase hex. */
  readonly networkIdHex: string;
  /** Issuer authority pubkey. */
  readonly issuerAuthority: Pubkey;
  /** BPP authority pubkey. */
  readonly bppAuthority: Pubkey;
  /** Unix seconds when the catalogue was built. */
  readonly publishedAtSec: number;
  /** Ordered capabilities array (always five entries, spec order). */
  readonly capabilities: readonly BankCapability[];
}

/* -------------------------------------------------------------------------- */
/* CatalogCommitPayload                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Canonical JSON payload that is signed and recorded (and eventually
 * published on-chain via FN-055's `PublishCatalog` instruction).
 *
 * Fields are intentionally flat and JSON-safe (no BigInt / Uint8Array)
 * so the payload can be canonicalised and hashed deterministically
 * across environments.
 *
 * TODO(FN-055): when on-chain `PublishCatalog` lands, the
 * `CatalogCommitRecorder` in `catalog-publisher.ts` becomes an RPC
 * adapter wrapping this payload.
 */
export interface CatalogCommitPayload {
  /** Network (IssuerNetwork) authority pubkey. */
  readonly networkPubkey: Pubkey;
  /** BPP authority pubkey. */
  readonly bppPubkey: Pubkey;
  /** Ordered capability list (five entries). */
  readonly capabilities: readonly BankCapability[];
  /** sha256(canonicalCatalogJson(catalog)) as lowercase hex. */
  readonly catalogHash: string;
  /** Unix seconds when the commit was created. */
  readonly publishedAtSec: number;
}

/* -------------------------------------------------------------------------- */
/* Zod schemas                                                                 */
/* -------------------------------------------------------------------------- */

/** Zod schema for a single `BankCapability`. */
export const zBankCapability = zCapabilityTags.extend({
  domain: z.literal("bank"),
  capabilityKey: z.enum([
    "bank.checking",
    "bank.savings",
    "bank.fiat-ramp",
    "bank.card",
    "bank.wire",
  ] as const),
});

/** Zod schema for the full `BankCatalog`. */
export const zBankCatalog = z
  .object({
    version: z.string().min(1),
    networkLabel: z.string().min(1),
    networkIdHex: z.string().regex(/^[0-9a-f]+$/).min(64).max(64),
    issuerAuthority: z.string().min(32).max(64),
    bppAuthority: z.string().min(32).max(64),
    publishedAtSec: z.number().int().nonnegative(),
    capabilities: z.array(zBankCapability).length(5),
  })
  .strict();

/** Zod schema for `CatalogCommitPayload`. */
export const zCatalogCommitPayload = z
  .object({
    networkPubkey: z.string().min(32).max(64),
    bppPubkey: z.string().min(32).max(64),
    capabilities: z.array(zBankCapability).length(5),
    catalogHash: z.string().regex(/^[0-9a-f]{64}$/),
    publishedAtSec: z.number().int().nonnegative(),
  })
  .strict();
