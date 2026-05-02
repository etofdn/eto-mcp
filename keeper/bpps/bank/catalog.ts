/**
 * Pure functions for building, canonicalising, and hashing the bank
 * BPP catalogue (FN-096 / T-3.9.1.2).
 *
 * All exports are side-effect-free (no I/O, no module-level state).
 *
 * ## Canonicalisation algorithm
 *
 * `canonicalCatalogJson(catalog)` serialises the catalogue to
 * deterministic JSON using the following rules, applied recursively:
 *
 *   1. Object keys are sorted lexicographically (Unicode code-point
 *      order, which matches `Array.prototype.sort()` default).
 *   2. Arrays preserve their element order.
 *   3. `undefined` values are dropped (identical to `JSON.stringify`
 *      behaviour for plain objects).
 *   4. No whitespace is emitted.
 *
 * The resulting string is byte-stable: given the same catalogue
 * object (same field values, same `publishedAtSec`), two independent
 * calls on any platform produce identical UTF-8 bytes.  Tests in
 * `tests/unit/bank-bpp.test.ts` assert this property.
 *
 * ## Network ID derivation
 *
 * `networkIdHex` is `BLAKE3-256(utf8(networkLabel))` encoded as
 * 64 lowercase hex chars.  The computation is delegated to
 * `computeBankNetworkId` imported from FN-095 (`apps/issuer-admin/src/
 * bank/init-network.ts`) so there is exactly one source of truth for
 * the hash function and label.
 */

import { createHash } from "node:crypto";
import {
  BANK_NETWORK_LABEL,
  computeBankNetworkId,
} from "../../../src/bank-network/init-network.js";
import type {
  BankCapability,
  BankCapabilityKey,
  BankCatalog,
  CatalogCommitPayload,
  Pubkey,
} from "./types.js";
import type { Currency, RequiredCredential } from "../../templates/bpp/types.js";

/* -------------------------------------------------------------------------- */
/* Capability key registry                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Frozen tuple of all five bank capability keys in canonical spec order:
 *   bank.checking, bank.savings, bank.fiat-ramp, bank.card, bank.wire
 *
 * Downstream code that needs to iterate over capabilities (e.g. the
 * BankHandler dispatch table, the test suite) should reference this
 * constant rather than hard-coding the list.
 */
export const BANK_CAPABILITY_KEYS: readonly BankCapabilityKey[] =
  Object.freeze([
    "bank.checking",
    "bank.savings",
    "bank.fiat-ramp",
    "bank.card",
    "bank.wire",
  ] as const);

/* -------------------------------------------------------------------------- */
/* Default pricing helpers                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_CURRENCY: Currency = "ETO";
const DEFAULT_AMOUNT = "0";

const CAPABILITY_DESCRIPTIONS: Readonly<Record<BankCapabilityKey, string>> = {
  "bank.checking": "Open a checking account and manage eUSD balance.",
  "bank.savings": "Open a savings account with interest accrual.",
  "bank.fiat-ramp": "Deposit or withdraw fiat currency (USD ↔ eUSD).",
  "bank.card": "Issue a debit card bound to a checking account.",
  "bank.wire": "Send or receive domestic/international wire transfers.",
};

/** Extract the action suffix from a capability key: `"bank.checking"` → `"checking"`. */
function actionFromKey(key: BankCapabilityKey): string {
  return key.slice("bank.".length);
}

/* -------------------------------------------------------------------------- */
/* buildBankCatalog                                                            */
/* -------------------------------------------------------------------------- */

export interface BuildBankCatalogOpts {
  /** BPP authority pubkey. */
  readonly bppAuthority: Pubkey;
  /** Issuer authority pubkey. */
  readonly issuerAuthority: Pubkey;
  /**
   * IssuerNetwork label.  Defaults to `BANK_NETWORK_LABEL` from FN-095.
   * Tests may supply a fixed value to keep snapshots deterministic.
   */
  readonly networkLabel?: string;
  /**
   * Unix seconds for `publishedAtSec`.  Defaults to `Math.floor(Date.now()/1000)`.
   * Tests should supply a fixed value for snapshot assertions.
   */
  readonly publishedAtSec?: number;
  /**
   * Optional per-capability pricing overrides.
   * Unspecified capabilities default to `{ amount: "0", currency: "ETO" }`.
   *
   * TODO(FN-098): catalogue JSON with real pricing lands as part of the
   * bank catalogue static price-list task.
   */
  readonly pricing?: Partial<
    Record<BankCapabilityKey, { readonly amount: string; readonly currency: Currency }>
  >;
  /**
   * Optional per-capability required-credential overrides.
   * Defaults to `[]` for every capability.
   *
   * TODO(FN-099): the verified-human gate wires real required credentials
   * into the bank.checking and bank.savings capabilities.
   */
  readonly requiredCredentials?: Partial<
    Record<BankCapabilityKey, readonly RequiredCredential[]>
  >;
}

/**
 * Build a `BankCatalog` with all five capabilities populated with sane
 * defaults.  Pure: no I/O or side effects.
 *
 * Capability ordering is guaranteed to match `BANK_CAPABILITY_KEYS`:
 *   [0] bank.checking, [1] bank.savings, [2] bank.fiat-ramp,
 *   [3] bank.card, [4] bank.wire
 */
export function buildBankCatalog(opts: BuildBankCatalogOpts): BankCatalog {
  const label = opts.networkLabel ?? BANK_NETWORK_LABEL;
  const networkIdBytes = computeBankNetworkId(label);
  const networkIdHex = Buffer.from(networkIdBytes).toString("hex");

  const capabilities: BankCapability[] = BANK_CAPABILITY_KEYS.map((key) => {
    const pricing = opts.pricing?.[key];
    const reqCreds = opts.requiredCredentials?.[key];
    const cap: BankCapability = {
      domain: "bank",
      action: actionFromKey(key),
      capabilityKey: key,
      version: "0.1.0",
      price: {
        amount: pricing?.amount ?? DEFAULT_AMOUNT,
        currency: pricing?.currency ?? DEFAULT_CURRENCY,
      },
      requiredCredentials: reqCreds ?? [],
      description: CAPABILITY_DESCRIPTIONS[key],
    };
    return cap;
  });

  return {
    version: "0.1.0",
    networkLabel: label,
    networkIdHex,
    issuerAuthority: opts.issuerAuthority,
    bppAuthority: opts.bppAuthority,
    publishedAtSec: opts.publishedAtSec ?? Math.floor(Date.now() / 1000),
    capabilities: Object.freeze(capabilities),
  };
}

/* -------------------------------------------------------------------------- */
/* canonicalCatalogJson                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Serialise `catalog` to deterministic JSON.
 *
 * Algorithm (applied recursively):
 *   • Objects: keys sorted lexicographically (Unicode code-point order).
 *   • Arrays: element order preserved.
 *   • `undefined` values dropped.
 *   • No extra whitespace.
 *
 * The output is byte-stable: identical catalogue objects produce
 * identical UTF-8 strings on any platform.
 */
export function canonicalCatalogJson(catalog: BankCatalog): string {
  return JSON.stringify(sortedKeys(catalog as unknown as JsonValue));
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonObject = { [k: string]: JsonValue };
type JsonArray = JsonValue[];

function sortedKeys(v: JsonValue): JsonValue {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortedKeys);
  const obj = v as JsonObject;
  const out: JsonObject = {};
  for (const k of Object.keys(obj).sort()) {
    const child = obj[k];
    if (child === undefined) continue;
    out[k] = sortedKeys(child as JsonValue);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* catalogHashHex                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the SHA-256 hash of the canonical JSON representation of
 * `catalog` and return it as lowercase 64-character hex.
 *
 * This is the value embedded in `CatalogCommitPayload.catalogHash`.
 */
export function catalogHashHex(catalog: BankCatalog): string {
  const json = canonicalCatalogJson(catalog);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* buildCatalogCommit                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Construct a `CatalogCommitPayload` from a `BankCatalog` and the
 * network's pubkey.
 *
 * The caller is responsible for signing the result (see
 * `catalog-publisher.ts`).
 */
export function buildCatalogCommit(
  catalog: BankCatalog,
  networkPubkey: Pubkey,
): CatalogCommitPayload {
  return {
    networkPubkey,
    bppPubkey: catalog.bppAuthority,
    capabilities: catalog.capabilities,
    catalogHash: catalogHashHex(catalog),
    publishedAtSec: catalog.publishedAtSec,
  };
}
