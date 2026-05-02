/**
 * Local copy of the essential bank-network helpers from the eto monorepo
 * (apps/issuer-admin/src/bank/init-network.ts).
 *
 * This file provides `BANK_NETWORK_LABEL` and `computeBankNetworkId` for use
 * by keeper/bpps/bank/catalog.ts and tests/unit/bank-bpp.test.ts without
 * requiring a cross-repo relative path that does not resolve in worktree
 * builds.
 *
 * Kept minimal — only the symbols needed within eto-mcp are exported.
 * The full borsh encoder/decoder lives in the eto monorepo.
 */

import { blake3 } from "@noble/hashes/blake3";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BANK_NETWORK_LABEL = "bank.eto.us-test";

/**
 * Schemas the bank `IssuerNetwork` is authorised to attest to.
 * Order mirrors the eto monorepo definition.
 */
export const BANK_ISSUABLE_SCHEMA_LABELS = Object.freeze([
  "account.checking",
  "account.savings",
  "bank.fiat-ramp-test",
  "card.debit",
] as const);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Compute the bank network id: BLAKE3-256 of the UTF-8 bytes of `label`.
 * Default `label` is {@link BANK_NETWORK_LABEL}.
 */
export function computeBankNetworkId(
  label: string = BANK_NETWORK_LABEL,
): Uint8Array {
  const out = blake3(utf8(label));
  if (out.length !== 32) {
    throw new Error(
      `internal: blake3 output expected 32 bytes, got ${out.length}`,
    );
  }
  return new Uint8Array(out);
}

/**
 * Return the canonical schema id hex for the given label.
 * `sha256("eto.beckn.schema.{label}.v1")`
 */
export function schemaIdHex(label: string): string {
  return createHash("sha256")
    .update(`eto.beckn.schema.${label}.v1`, "utf8")
    .digest("hex");
}
